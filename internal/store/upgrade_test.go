package store_test

import (
	"context"
	"testing"

	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

// A database created by the sign-in starter (migration 1 only) keeps its
// accounts when it is upgraded: local and Zitadel users still sign in.
func TestUpgradeFromSignInStarterKeepsAccounts(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		ctx := context.Background()
		old, err := store.OpenAt(ctx, b.URL, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, stmt := range []string{
			"INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('0192-local', 'Old@Example.com', 'Old', 1, 1)",
			"INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('0192-oidc', 'z@example.com', 'Zed', 1, 1)",
			`INSERT INTO identities (id, user_id, provider, issuer, subject, password_hash, created_at)
			 VALUES ('i1', '0192-local', 'local', 'local', 'old@example.com', 'hash-old', 1)`,
			`INSERT INTO identities (id, user_id, provider, issuer, subject, created_at)
			 VALUES ('i2', '0192-oidc', 'oidc', 'https://auth.example', 'sub-z', 1)`,
			`INSERT INTO sessions (id_hash, user_id, method, csrf_token, created_at, expires_at)
			 VALUES ('h1', '0192-local', 'local', 'c', 5, 9999999999999)`,
		} {
			if _, err := old.DB().ExecContext(ctx, stmt); err != nil {
				t.Fatalf("%s: %v", stmt, err)
			}
		}
		old.Close()

		st := storetest.Open(t, b)
		id, hash, err := st.LocalCredentials(ctx, "old@example.com")
		if err != nil || id != "0192-local" || hash != "hash-old" {
			t.Fatalf("LocalCredentials after upgrade = %q, %q, %v", id, hash, err)
		}
		u, err := st.UpsertOIDCUser(ctx, "https://auth.example", "sub-z", "z@example.com", "Zed")
		if err != nil || u.ID != "0192-oidc" {
			t.Fatalf("Zitadel user after upgrade = %+v, %v; want the existing account", u, err)
		}
		var lower string
		var lastSeen int64
		if err := st.DB().QueryRowContext(ctx, "SELECT email_lower FROM users WHERE id = '0192-local'").Scan(&lower); err != nil || lower != "old@example.com" {
			t.Fatalf("email_lower = %q, %v", lower, err)
		}
		if err := st.DB().QueryRowContext(ctx, "SELECT last_seen_at FROM sessions WHERE id_hash = 'h1'").Scan(&lastSeen); err != nil || lastSeen != 5 {
			t.Fatalf("sessions.last_seen_at = %d, %v; want created_at", lastSeen, err)
		}
	})
}
