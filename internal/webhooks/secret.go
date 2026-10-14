package webhooks

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/VBCDX/dispatch/internal/auth"
	"github.com/VBCDX/dispatch/internal/store"
)

// SecretPrefix starts every signing secret, so one is recognisable in a
// config file or a leaked log.
const SecretPrefix = "whsec_"

// sealPurpose binds sealed secrets to this use.
const sealPurpose = "dispatch-webhook-secret-v1"

// NewSecret returns a fresh signing secret: whsec_ and 32 base62
// characters (about 190 bits).
func NewSecret() string {
	return SecretPrefix + strings.TrimPrefix(store.NewID("x"), "x_") + strings.TrimPrefix(store.NewID("x"), "x_")
}

// Last4 is what the screens show of a secret.
func Last4(secret string) string {
	if len(secret) < 4 {
		return secret
	}
	return secret[len(secret)-4:]
}

// Box encrypts signing secrets at rest. The server needs the plaintext to
// sign and to verify, so secrets are sealed (AES-256-GCM), not hashed.
type Box struct{ s *auth.Sealer }

// NewBox derives the key from SESSION_SECRET when it is set. Otherwise it
// keeps a random key in keyFile (created on first use, mode 0600), so the
// secrets survive a restart. Changing SESSION_SECRET later makes existing
// secrets unreadable: their webhooks and listeners need a new secret.
// With neither (tests), the key is random and lasts as long as the process.
func NewBox(sessionSecret, keyFile string) (*Box, error) {
	key := sessionSecret
	if key != "" {
		key = "webhooks:" + key
	} else if keyFile != "" {
		k, err := loadOrCreateKey(keyFile)
		if err != nil {
			return nil, err
		}
		key = k
	}
	s, err := auth.NewSealer(key)
	if err != nil {
		return nil, err
	}
	return &Box{s: s}, nil
}

func loadOrCreateKey(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		if k := strings.TrimSpace(string(b)); len(k) >= 32 {
			return k, nil
		}
		return "", fmt.Errorf("webhooks: key file %s is too short", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("webhooks: read key file: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return "", fmt.Errorf("webhooks: create key directory: %w", err)
	}
	k := rand.Text() + rand.Text()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return loadOrCreateKey(path) // another process won the race
	}
	if err != nil {
		return "", fmt.Errorf("webhooks: create key file: %w", err)
	}
	if _, err := f.WriteString(k + "\n"); err != nil {
		f.Close()
		return "", fmt.Errorf("webhooks: write key file: %w", err)
	}
	return k, f.Close()
}

// Seal encrypts a secret for storage.
func (b *Box) Seal(secret string) string { return b.s.Seal(sealPurpose, []byte(secret)) }

// Open decrypts a stored secret.
func (b *Box) Open(sealed string) (string, error) {
	p, err := b.s.Open(sealPurpose, sealed)
	if err != nil {
		return "", errors.New("webhooks: the stored secret cannot be decrypted (was SESSION_SECRET changed?); rotate it")
	}
	return string(p), nil
}
