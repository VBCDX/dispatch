package server

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/config"
	"github.com/VBCDX/dispatch/internal/seed"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

func demoRole(t *testing.T, st *store.Store, userID string) string {
	t.Helper()
	m, err := st.GetOrgMembership(context.Background(), seed.DemoOrgID, userID)
	if errors.Is(err, store.ErrNotFound) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return m.Role
}

// With demo data on, a first sign-in joins the demo org as an Owner; later
// sign-ins leave the membership alone, even after it was removed.
func TestDemoDataFirstSignInJoinsDemoOrg(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := newHarness(t, b, config.AuthLocal, nil)
		h.cfg.SeedDemoData = true
		ctx := context.Background()
		if _, err := seed.Load(ctx, h.st, time.Now()); err != nil {
			t.Fatal(err)
		}
		u := h.createUser("new@example.com", "a long password")

		if res := h.login(h.client(), "new@example.com", "a long password"); res.StatusCode != http.StatusOK {
			t.Fatalf("login = %d", res.StatusCode)
		}
		if role := demoRole(t, h.st, u.ID); role != store.RoleOwner {
			t.Fatalf("after first sign-in, demo org role = %q, want Owner", role)
		}

		if _, err := h.st.DB().ExecContext(ctx, "DELETE FROM org_memberships WHERE user_id = '"+u.ID+"'"); err != nil {
			t.Fatal(err)
		}
		if res := h.login(h.client(), "new@example.com", "a long password"); res.StatusCode != http.StatusOK {
			t.Fatalf("second login = %d", res.StatusCode)
		}
		if role := demoRole(t, h.st, u.ID); role != "" {
			t.Fatalf("a later sign-in re-added the demo membership (%q)", role)
		}
	})
}

func TestNoDemoMembershipWhenDemoDataIsOff(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := newHarness(t, b, config.AuthZitadel, nil)
		if _, err := seed.Load(context.Background(), h.st, time.Now()); err != nil {
			t.Fatal(err)
		}
		c := h.client()
		h.do(c, http.MethodGet, h.oidcFlow(c), nil, nil)
		me, status := h.me(c)
		if status != http.StatusOK {
			t.Fatalf("me = %d", status)
		}
		if role := demoRole(t, h.st, me.User.ID); role != "" {
			t.Fatalf("demo data is off, but the user joined the demo org as %q", role)
		}
	})
}

// A first Zitadel sign-in also joins, and without the demo org loaded the
// sign-in still succeeds.
func TestDemoDataZitadelFirstSignIn(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := newHarness(t, b, config.AuthZitadel, nil)
		h.cfg.SeedDemoData = true

		c := h.client()
		h.do(c, http.MethodGet, h.oidcFlow(c), nil, nil)
		me, status := h.me(c)
		if status != http.StatusOK {
			t.Fatalf("sign-in without the demo org loaded: me = %d", status)
		}
		if role := demoRole(t, h.st, me.User.ID); role != "" {
			t.Fatalf("joined a demo org that does not exist: %q", role)
		}
	})
}
