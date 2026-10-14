package server

import (
	"context"
	"crypto/rand"
	"net/http"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/config"
	"github.com/VBCDX/dispatch/internal/seed"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

type orgsResponse struct {
	Orgs []orgJSON `json:"orgs"`
}

type workspacesResponse struct {
	Workspaces []workspaceJSON `json:"workspaces"`
}

type workspaceResponse struct {
	Workspace workspaceJSON `json:"workspace"`
}

// seededHarness is a server with the demo data loaded: Acme Corp (Dana is
// its Owner, Ravi a userAdmin, Mia and Sam users) and Northwind Labs (Leo
// is its Owner, Mia a user).
func seededHarness(t *testing.T, b storetest.Backend) *harness {
	t.Helper()
	h := newHarness(t, b, config.AuthLocal, nil)
	if _, err := seed.Load(context.Background(), h.st, time.Now()); err != nil {
		t.Fatal(err)
	}
	return h
}

// as returns a client signed in as an existing user, through a session
// created directly in the store (the demo users have no passwords).
func (h *harness) as(userID string) *http.Client {
	h.t.Helper()
	token := rand.Text()
	now := time.Now()
	if err := h.st.CreateSession(context.Background(), store.Session{
		IDHash: hashToken(token), UserID: userID, Method: methodLocal, CSRFToken: rand.Text(),
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}); err != nil {
		h.t.Fatal(err)
	}
	c := h.client()
	u, _ := url.Parse(h.ts.URL)
	c.Jar.SetCookies(u, []*http.Cookie{{Name: h.srv.cookieName(), Value: token, Path: "/"}})
	return c
}

func (h *harness) exec(query string) {
	h.t.Helper()
	if _, err := h.st.DB().ExecContext(context.Background(), query); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) get(c *http.Client, path string, want int) *http.Response {
	h.t.Helper()
	res := h.do(c, http.MethodGet, path, nil, nil)
	if res.StatusCode != want {
		h.t.Fatalf("GET %s = %d, want %d", path, res.StatusCode, want)
	}
	return res
}

func workspaceIDs(ws []workspaceJSON) []string {
	out := []string{}
	for _, w := range ws {
		out = append(out, w.ID)
	}
	return out
}

func TestAPIv1RequiresSession(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		for _, path := range []string{"/api/v1/orgs", "/api/v1/orgs/org_acme/workspaces", "/api/v1/orgs/org_acme/workspaces/ws_rel"} {
			res := h.get(h.client(), path, http.StatusUnauthorized)
			if e := decode[apiError](t, res); e.Error != "unauthenticated" {
				t.Errorf("GET %s: error = %q, want unauthenticated", path, e.Error)
			}
		}
	})
}

func TestAPIv1Orgs(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		got := decode[orgsResponse](t, h.get(h.as("u_mia"), "/api/v1/orgs", http.StatusOK)).Orgs
		want := []orgJSON{
			{ID: "org_acme", Name: "Acme Corp", Role: "user", Status: "active"},
			{ID: "org_nw", Name: "Northwind Labs", Role: "user", Status: "active"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("Mia's orgs = %+v, want %+v", got, want)
		}
		got = decode[orgsResponse](t, h.get(h.as("u_leo"), "/api/v1/orgs", http.StatusOK)).Orgs
		if len(got) != 1 || got[0].ID != "org_nw" {
			t.Errorf("Leo's orgs = %+v, want only org_nw", got)
		}
		// A user in no organization gets an empty list, not null.
		u := h.createUser("nobody@example.com", "a long password")
		res := h.get(h.as(u.ID), "/api/v1/orgs", http.StatusOK)
		if got := decode[map[string]any](t, res)["orgs"]; !reflect.DeepEqual(got, []any{}) {
			t.Errorf("orgs for a user in no org = %#v, want []", got)
		}
	})
}

func TestAPIv1WorkspacesList(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)

		// An Owner sees every workspace in the org, by name, and administers
		// them all; Dana has her own membership in two of them.
		ws := decode[workspacesResponse](t, h.get(h.as("u_dana"), "/api/v1/orgs/org_acme/workspaces", http.StatusOK)).Workspaces
		if got, want := workspaceIDs(ws), []string{"ws_inc", "ws_rel", "ws_sbx"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("Dana's workspaces = %v, want %v", got, want)
		}
		rel := ws[1]
		if rel.Name != "Release train" || rel.Humans != 3 || rel.Agents != 5 || rel.Waiting != 8 || rel.Webhooks != 2 || rel.BlockedAgents != 1 {
			t.Errorf("Release train row = %+v", rel)
		}
		if rel.MyRole == nil || *rel.MyRole != "workspace_admin" || !rel.CanAdmin {
			t.Errorf("Dana on Release train: my_role %v, can_admin %v", rel.MyRole, rel.CanAdmin)
		}
		if sbx := ws[2]; sbx.MyRole != nil || !sbx.CanAdmin {
			t.Errorf("Dana on Sandbox (no membership, org Owner): my_role %v, can_admin %v", sbx.MyRole, sbx.CanAdmin)
		}

		// A plain user sees only the workspaces they are a member of.
		ws = decode[workspacesResponse](t, h.get(h.as("u_mia"), "/api/v1/orgs/org_acme/workspaces", http.StatusOK)).Workspaces
		if got := workspaceIDs(ws); !reflect.DeepEqual(got, []string{"ws_rel"}) {
			t.Fatalf("Mia's Acme workspaces = %v, want [ws_rel]", got)
		}
		if ws[0].MyRole == nil || *ws[0].MyRole != "member" || ws[0].CanAdmin {
			t.Errorf("Mia on Release train: my_role %v, can_admin %v", ws[0].MyRole, ws[0].CanAdmin)
		}
		ws = decode[workspacesResponse](t, h.get(h.as("u_sam"), "/api/v1/orgs/org_acme/workspaces", http.StatusOK)).Workspaces
		if got := workspaceIDs(ws); !reflect.DeepEqual(got, []string{"ws_inc"}) || !ws[0].CanAdmin {
			t.Errorf("Sam's workspaces = %v (can_admin %v), want [ws_inc] as its admin", got, len(ws) > 0 && ws[0].CanAdmin)
		}

		// The same user in their other org sees that org's workspaces only.
		ws = decode[workspacesResponse](t, h.get(h.as("u_mia"), "/api/v1/orgs/org_nw/workspaces", http.StatusOK)).Workspaces
		if got := workspaceIDs(ws); !reflect.DeepEqual(got, []string{"ws_docs"}) {
			t.Errorf("Mia's Northwind workspaces = %v, want [ws_docs]", got)
		}

		// A deleted workspace drops out of the list.
		h.exec("UPDATE workspaces SET status = 'deleted' WHERE id = 'ws_sbx'")
		ws = decode[workspacesResponse](t, h.get(h.as("u_dana"), "/api/v1/orgs/org_acme/workspaces", http.StatusOK)).Workspaces
		if got := workspaceIDs(ws); !reflect.DeepEqual(got, []string{"ws_inc", "ws_rel"}) {
			t.Errorf("after deleting Sandbox, workspaces = %v", got)
		}
	})
}

// A workspace created outside Dispatch (the shared row exists, the Dispatch
// settings row does not) must not 500 the org list or its detail page -- the
// read path materializes the settings row.
func TestAPIv1WorkspaceCreatedOutsideDispatch(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		h.exec(`INSERT INTO workspaces (id, org_id, name, status, created_at, created_by_kind, created_by_id, updated_at, rev)
			VALUES ('ws_ext', 'org_acme', 'Outside', 'active', 0, 'user', 'u_dana', 0, 0)`)

		ws := decode[workspacesResponse](t, h.get(h.as("u_dana"), "/api/v1/orgs/org_acme/workspaces", http.StatusOK)).Workspaces
		if got, want := workspaceIDs(ws), []string{"ws_inc", "ws_ext", "ws_rel", "ws_sbx"}; !reflect.DeepEqual(got, want) {
			t.Errorf("owner list with an outside-Dispatch workspace = %v, want %v", got, want)
		}
		w := decode[workspaceResponse](t, h.get(h.as("u_dana"), "/api/v1/orgs/org_acme/workspaces/ws_ext", http.StatusOK)).Workspace
		if w.ID != "ws_ext" || w.Name != "Outside" {
			t.Errorf("outside-Dispatch workspace detail = %+v", w)
		}
	})
}

func TestAPIv1WorkspaceDetail(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		w := decode[workspaceResponse](t, h.get(h.as("u_mia"), "/api/v1/orgs/org_acme/workspaces/ws_rel", http.StatusOK)).Workspace
		if w.ID != "ws_rel" || w.Name != "Release train" || w.Humans != 3 || w.Agents != 5 || w.Messages24h != 11 || w.CanAdmin {
			t.Errorf("Release train for Mia = %+v", w)
		}
		w = decode[workspaceResponse](t, h.get(h.as("u_ravi"), "/api/v1/orgs/org_acme/workspaces/ws_inc", http.StatusOK)).Workspace
		if w.MyRole != nil || !w.CanAdmin {
			t.Errorf("Incidents for Ravi (userAdmin, no membership): my_role %v, can_admin %v", w.MyRole, w.CanAdmin)
		}
	})
}

// Everything outside the caller's organizations is 404, exactly like an ID
// that does not exist.
func TestAPIv1OrgScoping(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		leo, dana, mia := h.as("u_leo"), h.as("u_dana"), h.as("u_mia")
		cases := []struct {
			name string
			c    *http.Client
			path string
		}{
			{"another org's workspaces", leo, "/api/v1/orgs/org_acme/workspaces"},
			{"another org's workspace", leo, "/api/v1/orgs/org_acme/workspaces/ws_rel"},
			{"another org's workspace through your own org", leo, "/api/v1/orgs/org_nw/workspaces/ws_rel"},
			{"an Owner asking for another org", dana, "/api/v1/orgs/org_nw/workspaces"},
			{"an Owner asking for another org's workspace", dana, "/api/v1/orgs/org_acme/workspaces/ws_docs"},
			{"a workspace in your org you are not a member of", mia, "/api/v1/orgs/org_acme/workspaces/ws_inc"},
			{"an org that does not exist", dana, "/api/v1/orgs/org_missing/workspaces"},
			{"a workspace that does not exist", dana, "/api/v1/orgs/org_acme/workspaces/ws_missing"},
		}
		for _, tc := range cases {
			res := h.get(tc.c, tc.path, http.StatusNotFound)
			if e := decode[apiError](t, res); e.Error != "not_found" {
				t.Errorf("%s: error = %q, want not_found", tc.name, e.Error)
			}
		}

		// A deleted workspace is 404 even for an Owner.
		h.exec("UPDATE workspaces SET status = 'deleted' WHERE id = 'ws_sbx'")
		h.get(dana, "/api/v1/orgs/org_acme/workspaces/ws_sbx", http.StatusNotFound)

		// Suspended in one org: that org is 404, the other is untouched, and
		// the switcher still lists it with its status.
		h.exec("UPDATE org_memberships SET status = 'suspended', suspended_from = 'active', suspension_id = 'susp_test' WHERE id = 'om_acme_mia'")
		h.get(mia, "/api/v1/orgs/org_acme/workspaces", http.StatusNotFound)
		h.get(mia, "/api/v1/orgs/org_acme/workspaces/ws_rel", http.StatusNotFound)
		h.get(mia, "/api/v1/orgs/org_nw/workspaces", http.StatusOK)
		orgs := decode[orgsResponse](t, h.get(mia, "/api/v1/orgs", http.StatusOK)).Orgs
		if len(orgs) != 2 || orgs[0].ID != "org_acme" || orgs[0].Status != "suspended" {
			t.Errorf("Mia's orgs while suspended in Acme = %+v", orgs)
		}
	})
}

// The issue's acceptance path: with demo data on, a new local account signs
// in, sees Acme Corp in the switcher and the seeded workspaces.
func TestAPIv1DemoSignInSeesAcme(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		h.cfg.SeedDemoData = true
		h.createUser("new@example.com", "a long password")
		c := h.client()
		if res := h.login(c, "new@example.com", "a long password"); res.StatusCode != http.StatusOK {
			t.Fatalf("login = %d", res.StatusCode)
		}
		orgs := decode[orgsResponse](t, h.get(c, "/api/v1/orgs", http.StatusOK)).Orgs
		if len(orgs) != 1 || orgs[0].Name != "Acme Corp" || orgs[0].Role != store.RoleOwner {
			t.Fatalf("orgs after demo sign-in = %+v", orgs)
		}
		ws := decode[workspacesResponse](t, h.get(c, "/api/v1/orgs/org_acme/workspaces", http.StatusOK)).Workspaces
		if got := workspaceIDs(ws); !reflect.DeepEqual(got, []string{"ws_inc", "ws_rel", "ws_sbx"}) {
			t.Errorf("demo workspaces = %v", got)
		}
	})
}
