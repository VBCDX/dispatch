package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/VBCDX/dispatch/internal/auth"
	"github.com/VBCDX/dispatch/internal/config"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

func TestUserCreateCommand(t *testing.T) {
	b := storetest.Backends(t)[0]
	t.Setenv("DATABASE_URL", b.URL)
	var out bytes.Buffer
	ctx := context.Background()

	err := userCmd(ctx, []string{"create", "--email", "Ty@Example.com", "--name", "Ty", "--password-stdin"},
		strings.NewReader("correct horse battery\n"), &out)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "created ty@example.com") {
		t.Fatalf("output %q", out.String())
	}

	st := storetest.Open(t, b)
	_, hash, err := st.LocalCredentials(ctx, "ty@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := auth.VerifyPassword(hash, "correct horse battery"); !ok {
		t.Fatal("stored hash does not verify the password given on stdin")
	}

	for name, args := range map[string][]string{
		"duplicate":    {"create", "--email", "ty@example.com", "--password-stdin"},
		"no email":     {"create", "--password-stdin"},
		"bad email":    {"create", "--email", "not-an-email", "--password-stdin"},
		"no create":    {"delete"},
		"unknown flag": {"create", "--admin"},
	} {
		if err := userCmd(ctx, args, strings.NewReader("correct horse battery\n"), io.Discard); err == nil {
			t.Errorf("%s: succeeded", name)
		}
	}
	if err := userCmd(ctx, []string{"create", "--email", "short@example.com", "--password-stdin"},
		strings.NewReader("short\n"), io.Discard); err == nil {
		t.Error("short password accepted")
	}
}

func TestBootstrapOnlyIntoEmptyDatabase(t *testing.T) {
	b := storetest.Backends(t)[0]
	st := storetest.Open(t, b)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	boot := config.Bootstrap{Email: "admin@example.com", Name: "Admin", Password: "bootstrap password"}

	if err := bootstrapAdmin(ctx, st, config.Bootstrap{}, log); err != nil {
		t.Fatal(err)
	}
	if n, _ := st.CountUsers(ctx); n != 0 {
		t.Fatal("bootstrap with no variables created a user")
	}
	if err := bootstrapAdmin(ctx, st, boot, log); err != nil {
		t.Fatal(err)
	}
	if n, _ := st.CountUsers(ctx); n != 1 {
		t.Fatalf("users = %d after bootstrap, want 1", n)
	}
	// Second start with the variables still set, and a changed password:
	// nothing happens, the original password stays.
	boot.Password = "a different password"
	if err := bootstrapAdmin(ctx, st, boot, log); err != nil {
		t.Fatal(err)
	}
	_, hash, _ := st.LocalCredentials(ctx, "admin@example.com")
	if ok, _ := auth.VerifyPassword(hash, "bootstrap password"); !ok {
		t.Fatal("bootstrap ran again on a non-empty database")
	}
}

// fakeBootstrapStore exercises the bootstrap race deterministically: the real
// store cannot be made to return CountUsers()==0 and then ErrExists on create
// without winning an actual race.
type fakeBootstrapStore struct {
	count  int
	create func(ctx context.Context, email, name, passwordHash string) (store.User, error)
}

func (f fakeBootstrapStore) CountUsers(context.Context) (int, error) { return f.count, nil }

func (f fakeBootstrapStore) CreateLocalUser(ctx context.Context, email, name, passwordHash string) (store.User, error) {
	return f.create(ctx, email, name, passwordHash)
}

func TestBootstrapLostRaceStartsAnyway(t *testing.T) {
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	st := fakeBootstrapStore{count: 0, create: func(context.Context, string, string, string) (store.User, error) {
		return store.User{}, store.ErrExists
	}}
	boot := config.Bootstrap{Email: "admin@example.com", Name: "Admin", Password: "bootstrap password"}
	if err := bootstrapAdmin(ctx, st, boot, log); err != nil {
		t.Fatalf("the instance that lost the bootstrap race must start anyway: %v", err)
	}
}

func TestCreateLocalUserKeepsExistsSentinel(t *testing.T) {
	ctx := context.Background()
	st := fakeBootstrapStore{create: func(context.Context, string, string, string) (store.User, error) {
		return store.User{}, store.ErrExists
	}}
	_, err := createLocalUser(ctx, st, "admin@example.com", "Admin", "bootstrap password")
	if !errors.Is(err, store.ErrExists) {
		t.Fatalf("err = %v; createLocalUser must keep store.ErrExists in the chain for the race branch", err)
	}
}

func TestHelpPrintsUsageWithoutServing(t *testing.T) {
	ctx := context.Background()
	serve := func(context.Context) error {
		t.Fatal("the server started")
		return nil
	}
	for _, arg := range []string{"help", "-h", "-help", "--help"} {
		var out bytes.Buffer
		if err := run(ctx, []string{arg}, strings.NewReader(""), &out, serve); err != nil {
			t.Fatalf("dispatch %s: %v", arg, err)
		}
		if !strings.HasPrefix(out.String(), "usage: dispatch") {
			t.Fatalf("dispatch %s printed %q", arg, out.String())
		}
	}
	for _, arg := range []string{"--port", "-x", "bogus"} {
		if err := run(ctx, []string{arg}, strings.NewReader(""), io.Discard, serve); err == nil {
			t.Errorf("dispatch %s: no error", arg)
		}
	}
	served := false
	for _, args := range [][]string{nil, {"serve"}} {
		served = false
		err := run(ctx, args, strings.NewReader(""), io.Discard, func(context.Context) error { served = true; return nil })
		if err != nil || !served {
			t.Errorf("dispatch %v: served=%v err=%v; want the server", args, served, err)
		}
	}
}

func TestSeedCommandLoadsOnce(t *testing.T) {
	b := storetest.Backends(t)[0]
	t.Setenv("DATABASE_URL", b.URL)
	ctx := context.Background()

	var out bytes.Buffer
	if err := run(ctx, []string{"seed"}, nil, &out, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "loaded demo data: ") {
		t.Fatalf("first run printed %q", out.String())
	}
	out.Reset()
	if err := run(ctx, []string{"seed"}, nil, &out, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "nothing to do") {
		t.Fatalf("second run printed %q, want nothing to do", out.String())
	}
	if err := run(ctx, []string{"seed", "--force"}, nil, io.Discard, nil); err == nil {
		t.Fatal("seed accepted an unknown argument")
	}
}

func TestSeedIfEmptyOnlySeedsAnEmptyDatabase(t *testing.T) {
	b := storetest.Backends(t)[0]
	st := storetest.Open(t, b)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	if _, err := st.DB().ExecContext(ctx, `INSERT INTO orgs (id, name, status, created_at, created_by_kind, created_by_id, updated_at, rev)
		VALUES ('org_real', 'Real Org', 'active', 1, 'user', 'u_x', 1, 0)`); err != nil {
		t.Fatal(err)
	}
	if err := seedIfEmpty(ctx, st, log); err != nil {
		t.Fatal(err)
	}
	if n, _ := st.CountOrgs(ctx); n != 1 {
		t.Fatalf("seeded a database that already had an org: %d orgs", n)
	}

	empty := storetest.Open(t, storetest.Backends(t)[0])
	if err := seedIfEmpty(ctx, empty, log); err != nil {
		t.Fatal(err)
	}
	if n, _ := empty.CountOrgs(ctx); n != 2 {
		t.Fatalf("empty database has %d orgs after seeding, want the 2 demo orgs", n)
	}
}
