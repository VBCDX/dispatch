// Package agentauth answers "may this agent do this in this workspace?"
// from memory. A token pair is looked up in the database the first time
// it is seen and then served from an in-process cache, so the agent send
// and deliver path never waits on SQL.
//
// Entries are dropped when access changes (Invalidate, driven by the bus
// so every node hears it) and refreshed in the background after
// RefreshAfter, which bounds how stale an entry can be if a change was
// made without an invalidation. Valkey can sit behind the same Cache
// interface later; for now everything is in process.
package agentauth

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/VBCDX/dispatch/internal/store"
)

// ErrUnauthenticated means the tokens are unknown, revoked or expired.
var ErrUnauthenticated = errors.New("agentauth: invalid agent or workspace token")

// Cache is the access lookup the server uses.
type Cache interface {
	// Get returns the access for an agent token hash and workspace token
	// hash, or ErrUnauthenticated.
	Get(ctx context.Context, agentHash, wsHash string) (store.AgentAccess, error)
	// Invalidate drops every entry match accepts, and every negative entry.
	Invalidate(match func(store.AgentAccess) bool)
}

// Loader reads a pair's access from the system of record. It returns
// store.ErrNotFound for an unknown or unusable pair.
type Loader func(ctx context.Context, agentHash, wsHash string, now time.Time) (store.AgentAccess, error)

// Defaults for Memory.
const (
	DefaultRefreshAfter = 30 * time.Second
	DefaultNegativeTTL  = 30 * time.Second
	maxEntries          = 100_000
	maxNegative         = 10_000
	loadTimeout         = 5 * time.Second
)

type key struct{ agent, ws string }

type entry struct {
	access     store.AgentAccess
	loadedAt   time.Time
	refreshing bool
}

type call struct {
	done   chan struct{}
	access store.AgentAccess
	err    error
}

// Memory is the in-process Cache.
type Memory struct {
	load         Loader
	now          func() time.Time
	refreshAfter time.Duration
	negativeTTL  time.Duration

	mu       sync.Mutex
	entries  map[key]*entry
	negative map[key]time.Time // when the "not found" answer expires
	inflight map[key]*call
	gen      uint64 // bumped by Invalidate, so a load that raced one is not cached
}

// NewMemory returns an empty cache over load.
func NewMemory(load Loader, now func() time.Time) *Memory {
	if now == nil {
		now = time.Now
	}
	return &Memory{
		load: load, now: now, refreshAfter: DefaultRefreshAfter, negativeTTL: DefaultNegativeTTL,
		entries: map[key]*entry{}, negative: map[key]time.Time{}, inflight: map[key]*call{},
	}
}

// Get serves from memory. Only a pair never seen (or dropped) goes to the
// loader, and concurrent first lookups of one pair share one load.
func (c *Memory) Get(ctx context.Context, agentHash, wsHash string) (store.AgentAccess, error) {
	k := key{agentHash, wsHash}
	now := c.now()
	c.mu.Lock()
	if e, ok := c.entries[k]; ok {
		if exp := e.access.ExpiresAt; exp != nil && !now.Before(*exp) {
			delete(c.entries, k)
			c.mu.Unlock()
			return store.AgentAccess{}, ErrUnauthenticated
		}
		if !e.refreshing && now.Sub(e.loadedAt) >= c.refreshAfter {
			e.refreshing = true
			go c.refresh(k)
		}
		a := e.access
		c.mu.Unlock()
		return a, nil
	}
	if until, ok := c.negative[k]; ok {
		if now.Before(until) {
			c.mu.Unlock()
			return store.AgentAccess{}, ErrUnauthenticated
		}
		delete(c.negative, k)
	}
	cl, ok := c.inflight[k]
	if !ok {
		cl = &call{done: make(chan struct{})}
		c.inflight[k] = cl
		go c.fill(k, cl, c.gen)
	}
	c.mu.Unlock()

	select {
	case <-cl.done:
		return cl.access, cl.err
	case <-ctx.Done():
		return store.AgentAccess{}, ctx.Err()
	}
}

// fill loads a pair for the first time. It runs detached from any one
// caller's context, so a caller giving up does not fail the others.
func (c *Memory) fill(k key, cl *call, gen uint64) {
	ctx, cancel := context.WithTimeout(context.Background(), loadTimeout)
	defer cancel()
	a, err := c.load(ctx, k.agent, k.ws, c.now())
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inflight, k)
	switch {
	case errors.Is(err, store.ErrNotFound):
		err = ErrUnauthenticated
		if gen == c.gen {
			if len(c.negative) >= maxNegative {
				clear(c.negative)
			}
			c.negative[k] = c.now().Add(c.negativeTTL)
		}
	case err == nil && gen == c.gen:
		c.put(k, a)
	}
	cl.access, cl.err = a, err
	close(cl.done)
}

// refresh reloads an entry in the background; the old answer keeps being
// served meanwhile. A pair that no longer resolves is dropped. A failed
// load (database down) keeps the old answer until the next refresh.
func (c *Memory) refresh(k key) {
	c.mu.Lock()
	gen := c.gen
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), loadTimeout)
	defer cancel()
	a, err := c.load(ctx, k.agent, k.ws, c.now())
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[k]
	if !ok || gen != c.gen {
		return
	}
	switch {
	case errors.Is(err, store.ErrNotFound):
		delete(c.entries, k)
	case err != nil:
		e.refreshing, e.loadedAt = false, c.now()
	default:
		c.put(k, a)
	}
}

func (c *Memory) put(k key, a store.AgentAccess) {
	if _, ok := c.entries[k]; !ok && len(c.entries) >= maxEntries {
		for old := range c.entries { // evict an arbitrary entry; it reloads on next use
			delete(c.entries, old)
			break
		}
	}
	c.entries[k] = &entry{access: a, loadedAt: c.now()}
}

// Invalidate drops matching entries and all negative entries. Loads in
// flight when it runs are not cached.
func (c *Memory) Invalidate(match func(store.AgentAccess) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	for k, e := range c.entries {
		if match(e.access) {
			delete(c.entries, k)
		}
	}
	clear(c.negative)
}
