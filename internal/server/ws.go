package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/nats-io/nats.go"

	"github.com/VBCDX/dispatch/internal/bus"
)

// WebSocket limits for the proof endpoint.
const (
	wsMaxFrame       = 64 << 10
	wsMaxSubs        = 100
	wsMaxWatches     = 10
	wsSendQueue      = 1024
	wsMaxSubjectLen  = 200
	wsWriteTimeout   = 10 * time.Second
	wsPublishTimeout = 5 * time.Second
)

// Frames the client sends:
//
//	{"op":"sub","subject":"room.a"}            subscribe ("*" and a trailing ">" allowed)
//	{"op":"unsub","subject":"room.a"}
//	{"op":"pub","subject":"room.a","data":…,"id":"1"}  publish; "data" is any JSON value
//
// Frames the server sends:
//
//	{"op":"msg","subject":"room.a","data":…}
//	{"op":"ack","id":"1"}                       the stream has stored the publish
//	{"op":"subscribed","subject":"room.a"}
//	{"op":"unsubscribed","subject":"room.a"}     no more messages for it after this
//	{"op":"error","id":"1","error":"…"}
//
// Watching a workspace (the Messages tab):
//
//	{"op":"watch","org":"org_…","workspace":"ws_…"}    needs read access to the workspace
//	{"op":"unwatch","workspace":"ws_…"}
//
// sends {"op":"watching","workspace":…}, then for every new message
// {"op":"message","workspace":…,"seq":42,"data":<message>} and for
// receipts and presence {"op":"event","workspace":…,"data":<event>}.
// When the user loses access (removed from the workspace or the org,
// suspended, no longer an org admin, the workspace deleted) the watch
// stops at once with {"op":"unwatched","workspace":…,"error":"access removed"}.
//
// Every subject is relative to the signed-in user's own space
// (dispatch.u.<user id>.), so a client can reach neither another user's
// messages nor NATS system subjects. Workspaces replace this with the
// data model.
type wsIn struct {
	Op        string          `json:"op"`
	Subject   string          `json:"subject"`
	Data      json.RawMessage `json:"data"`
	ID        string          `json:"id,omitempty"`
	Org       string          `json:"org,omitempty"`
	Workspace string          `json:"workspace,omitempty"`
}

type wsOut struct {
	Op        string          `json:"op"`
	Subject   string          `json:"subject,omitempty"`
	Workspace string          `json:"workspace,omitempty"`
	Seq       uint64          `json:"seq,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	ID        string          `json:"id,omitempty"`
	Error     string          `json:"error,omitempty"`
}

func userSubjectPrefix(userID string) string { return bus.SubjectPrefix + "u." + userID + "." }

// validSubject checks a client-relative subject: dot-separated tokens of
// letters, digits, '-' and '_'; wildcards only when subscribing.
func validSubject(subj string, wildcards bool) bool {
	if subj == "" || len(subj) > wsMaxSubjectLen {
		return false
	}
	tokens := strings.Split(subj, ".")
	for i, t := range tokens {
		switch {
		case t == "":
			return false
		case t == "*" && wildcards:
		case t == ">" && wildcards && i == len(tokens)-1:
		default:
			for _, c := range t {
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
					return false
				}
			}
		}
	}
	return true
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	a := fromContext(r.Context())
	// Browsers always send Origin on a WebSocket handshake; only our own
	// origin may open one with the session cookie.
	if o := r.Header.Get("Origin"); o != "" && o != s.cfg.Origin() {
		writeError(w, http.StatusForbidden, "origin", "cross-origin WebSocket refused")
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true}) // origin checked above
	if err != nil {
		return
	}
	conn.SetReadLimit(wsMaxFrame)

	ctx, cancel := context.WithDeadline(context.Background(), a.session.ExpiresAt)
	defer cancel()

	c := &wsConn{
		srv:     s,
		conn:    conn,
		prefix:  userSubjectPrefix(a.user.ID),
		out:     make(chan []byte, wsSendQueue),
		subs:    map[string]*nats.Subscription{},
		watches: map[string]watch{},
		user:    a.user.ID,
		ctx:     ctx,
		cancel:  cancel,
	}
	defer c.unsubscribeAll()
	s.browsers.add(c)
	defer s.browsers.remove(c)

	revoked, err := s.bus.Conn().Subscribe(bus.SessionRevokedSubject(a.session.IDHash), func(*nats.Msg) { cancel() })
	if err != nil {
		conn.Close(websocket.StatusInternalError, "subscribe failed")
		return
	}
	defer revoked.Unsubscribe()

	go c.writeLoop(ctx)
	err = c.readLoop(ctx)

	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		conn.Close(websocket.StatusPolicyViolation, "session expired")
	case ctx.Err() != nil && c.slow.Load():
		conn.Close(websocket.StatusPolicyViolation, "slow consumer")
	case ctx.Err() != nil:
		conn.Close(websocket.StatusPolicyViolation, "signed out")
	case websocket.CloseStatus(err) != -1:
		conn.Close(websocket.StatusNormalClosure, "")
	default:
		conn.CloseNow()
	}
}
