package agentauth

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/store"
)

type fakeDB struct {
	mu    sync.Mutex
	rows  map[key]store.AgentAccess
	loads atomic.Int32
	gate  chan struct{} // when set, loads wait on it
}

func (f *fakeDB) load(_ context.Context, a, w string, _ time.Time) (store.AgentAccess, error) {
	f.loads.Add(1)
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	acc, ok := f.rows[key{a, w}]
	if !ok {
		return store.AgentAccess{}, store.ErrNotFound
	}
	return acc, nil
}

func (f *fakeDB) set(a, w string, acc *store.AgentAccess) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if acc == nil {
		delete(f.rows, key{a, w})
	} else {
		f.rows[key{a, w}] = *acc
	}
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newTest() (*Memory, *fakeDB, *clock) {
	db := &fakeDB{rows: map[key]store.AgentAccess{}}
	clk := &clock{t: time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)}
	return NewMemory(db.load, clk.now), db, clk
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestHitsServeFromMemory(t *testing.T) {
	c, db, _ := newTest()
	db.set("a", "w", &store.AgentAccess{AgentID: "ag_1", Write: true})
	ctx := context.Background()
	for range 100 {
		a, err := c.Get(ctx, "a", "w")
		if err != nil || a.AgentID != "ag_1" {
			t.Fatalf("Get = %+v, %v", a, err)
		}
	}
	if n := db.loads.Load(); n != 1 {
		t.Errorf("loads = %d, want 1", n)
	}
}

func TestConcurrentFirstLookupsShareOneLoad(t *testing.T) {
	c, db, _ := newTest()
	db.set("a", "w", &store.AgentAccess{AgentID: "ag_1"})
	db.gate = make(chan struct{})
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if _, err := c.Get(context.Background(), "a", "w"); err != nil {
				t.Error(err)
			}
		})
	}
	waitFor(t, func() bool { return db.loads.Load() >= 1 })
	close(db.gate)
	wg.Wait()
	if n := db.loads.Load(); n != 1 {
		t.Errorf("loads = %d, want 1", n)
	}
}

func TestUnknownTokensAreCachedBriefly(t *testing.T) {
	c, db, clk := newTest()
	ctx := context.Background()
	for range 5 {
		if _, err := c.Get(ctx, "x", "y"); !errors.Is(err, ErrUnauthenticated) {
			t.Fatalf("err = %v", err)
		}
	}
	if n := db.loads.Load(); n != 1 {
		t.Errorf("loads = %d, want 1", n)
	}
	clk.add(DefaultNegativeTTL)
	_, _ = c.Get(ctx, "x", "y")
	if n := db.loads.Load(); n != 2 {
		t.Errorf("loads after TTL = %d, want 2", n)
	}
}

func TestInvalidateDropsMatchingEntries(t *testing.T) {
	c, db, _ := newTest()
	ctx := context.Background()
	db.set("a1", "w", &store.AgentAccess{AgentID: "ag_1", MembershipID: "wm_1"})
	db.set("a2", "w", &store.AgentAccess{AgentID: "ag_2", MembershipID: "wm_2"})
	_, _ = c.Get(ctx, "a1", "w")
	_, _ = c.Get(ctx, "a2", "w")

	db.set("a1", "w", nil) // revoked in the database
	c.Invalidate(func(a store.AgentAccess) bool { return a.AgentID == "ag_1" })
	if _, err := c.Get(ctx, "a1", "w"); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("revoked pair: err = %v, want ErrUnauthenticated", err)
	}
	if _, err := c.Get(ctx, "a2", "w"); err != nil {
		t.Errorf("other pair: err = %v", err)
	}
	if n := db.loads.Load(); n != 3 {
		t.Errorf("loads = %d, want 3 (only the invalidated pair reloads)", n)
	}
}

func TestStaleEntriesRefreshInTheBackground(t *testing.T) {
	c, db, clk := newTest()
	ctx := context.Background()
	db.set("a", "w", &store.AgentAccess{AgentID: "ag_1", Write: true})
	_, _ = c.Get(ctx, "a", "w")

	db.set("a", "w", &store.AgentAccess{AgentID: "ag_1", Write: false}) // changed without an invalidation
	clk.add(DefaultRefreshAfter)
	a, _ := c.Get(ctx, "a", "w")
	if !a.Write {
		t.Error("the stale answer should be served while refreshing")
	}
	waitFor(t, func() bool { a, _ := c.Get(ctx, "a", "w"); return !a.Write })

	db.set("a", "w", nil) // gone
	clk.add(DefaultRefreshAfter)
	_, _ = c.Get(ctx, "a", "w")
	waitFor(t, func() bool {
		_, err := c.Get(ctx, "a", "w")
		return errors.Is(err, ErrUnauthenticated)
	})
}

func TestExpiredTokenIsRefused(t *testing.T) {
	c, db, clk := newTest()
	exp := clk.now().Add(time.Minute)
	db.set("a", "w", &store.AgentAccess{AgentID: "ag_1", ExpiresAt: &exp})
	if _, err := c.Get(context.Background(), "a", "w"); err != nil {
		t.Fatal(err)
	}
	clk.add(time.Minute)
	if _, err := c.Get(context.Background(), "a", "w"); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("err = %v, want ErrUnauthenticated", err)
	}
}

func TestLoadRacingInvalidateIsNotCached(t *testing.T) {
	c, db, _ := newTest()
	db.set("a", "w", &store.AgentAccess{AgentID: "ag_1"})
	db.gate = make(chan struct{})
	res := make(chan error, 1)
	go func() { _, err := c.Get(context.Background(), "a", "w"); res <- err }()
	waitFor(t, func() bool { return db.loads.Load() == 1 })
	c.Invalidate(func(store.AgentAccess) bool { return true }) // revoked while the load was reading
	close(db.gate)
	<-res
	db.gate = nil
	db.set("a", "w", nil)
	if _, err := c.Get(context.Background(), "a", "w"); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("err = %v: a load that raced an invalidation was cached", err)
	}
}
