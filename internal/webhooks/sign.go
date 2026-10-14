// Package webhooks sends a workspace's messages to outside URLs and turns
// signed calls from outside into messages.
//
// Outgoing delivery never runs on the send path. A durable JetStream
// consumer reads the messages stream, matches each message against the
// workspace's webhooks held in memory, and queues one job per match on the
// webhooks stream. Workers post each job, signed, retry it with backoff
// and, when every attempt has failed, record it as a dead letter that an
// admin can redeliver. A slow or dead target only slows its own jobs.
//
// Incoming listener calls are verified with the same signature scheme and
// published through the normal message path.
//
// The signature scheme, retries and payload are documented in
// docs/webhooks.md.
package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Headers on every delivery, and the one a listener call must carry.
const (
	SignatureHeader = "Dispatch-Signature"
	EventHeader     = "Dispatch-Event"
	DeliveryHeader  = "Dispatch-Delivery"
	WebhookHeader   = "Dispatch-Webhook"
)

// SignatureTolerance is how far a signature's timestamp may be from the
// receiver's clock. Older signatures are refused, so a captured request
// cannot be replayed later.
const SignatureTolerance = 5 * time.Minute

// Errors from Verify. They are deliberately vague towards the caller.
var (
	ErrNoSignature  = errors.New("webhooks: missing or malformed signature header")
	ErrBadSignature = errors.New("webhooks: signature does not match")
	ErrStale        = errors.New("webhooks: signature timestamp is outside the tolerance")
)

// Sign returns the Dispatch-Signature value for body sent at t:
// "t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>".
func Sign(secret string, t time.Time, body []byte) string {
	ts := strconv.FormatInt(t.Unix(), 10)
	return "t=" + ts + ",v1=" + hex.EncodeToString(mac(secret, ts, body))
}

func mac(secret, ts string, body []byte) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(ts))
	m.Write([]byte{'.'})
	m.Write(body)
	return m.Sum(nil)
}

// Verify checks a Dispatch-Signature header against body. Several v1
// values may be present (during a secret rotation a sender can sign with
// both); any one matching is enough. The timestamp must be within
// tolerance of now.
func Verify(secret, header string, body []byte, now time.Time, tolerance time.Duration) error {
	var ts string
	var sigs [][]byte
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			ts = v
		case "v1":
			if b, err := hex.DecodeString(v); err == nil && len(b) == sha256.Size {
				sigs = append(sigs, b)
			}
		}
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || len(sigs) == 0 {
		return ErrNoSignature
	}
	if d := now.Sub(time.Unix(sec, 0)); d > tolerance || d < -tolerance {
		return ErrStale
	}
	want := mac(secret, ts, body)
	for _, s := range sigs {
		if hmac.Equal(s, want) {
			return nil
		}
	}
	return ErrBadSignature
}
