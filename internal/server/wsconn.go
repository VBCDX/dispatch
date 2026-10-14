package server

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
	"github.com/nats-io/nats.go"
)

type wsConn struct {
	srv    *Server
	conn   *websocket.Conn
	prefix string
	out    chan []byte
	ctx    context.Context // ends with the connection
	cancel context.CancelFunc
	slow   atomic.Bool

	user string

	mu      sync.Mutex
	subs    map[string]*nats.Subscription
	watches map[string]watch // by workspace ID
}

// watch is one workspace the Messages tab is watching.
type watch struct {
	org  string
	stop func()
}

// send queues a frame. If the client cannot keep up, the connection is
// closed rather than letting the queue grow or stalling NATS delivery.
func (c *wsConn) send(frame []byte) {
	select {
	case c.out <- frame:
	default:
		c.slow.Store(true)
		c.cancel()
	}
}

func (c *wsConn) sendJSON(v wsOut) {
	b, err := json.Marshal(v)
	if err != nil {
		c.srv.log.Warn("encode WebSocket frame failed", "err", err)
		return
	}
	c.send(b)
}

func (c *wsConn) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-c.out:
			wctx, cancel := context.WithTimeout(ctx, wsWriteTimeout)
			err := c.conn.Write(wctx, websocket.MessageText, frame)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

func (c *wsConn) readLoop(ctx context.Context) error {
	for {
		typ, raw, err := c.conn.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			c.sendJSON(wsOut{Op: "error", Error: "send JSON text frames"})
			continue
		}
		var in wsIn
		if err := json.Unmarshal(raw, &in); err != nil {
			c.sendJSON(wsOut{Op: "error", Error: "invalid JSON"})
			continue
		}
		switch in.Op {
		case "pub":
			c.publish(ctx, in)
		case "sub":
			c.subscribe(in)
		case "unsub":
			c.unsubscribe(in)
		case "watch":
			c.watch(ctx, in)
		case "unwatch":
			c.unwatch(in)
		default:
			c.sendJSON(wsOut{Op: "error", ID: in.ID, Error: "unknown op"})
		}
	}
}

func (c *wsConn) publish(ctx context.Context, in wsIn) {
	if !validSubject(in.Subject, false) {
		c.sendJSON(wsOut{Op: "error", ID: in.ID, Error: "invalid subject"})
		return
	}
	if len(in.Data) == 0 {
		in.Data = json.RawMessage("null")
	}
	pctx, cancel := context.WithTimeout(ctx, wsPublishTimeout)
	defer cancel()
	if err := c.srv.bus.Publish(pctx, c.prefix+in.Subject, in.Data); err != nil {
		c.srv.log.Warn("publish failed", "err", err)
		c.sendJSON(wsOut{Op: "error", ID: in.ID, Error: "publish failed"})
		return
	}
	if in.ID != "" {
		c.sendJSON(wsOut{Op: "ack", ID: in.ID})
	}
}

func (c *wsConn) subscribe(in wsIn) {
	if !validSubject(in.Subject, true) {
		c.sendJSON(wsOut{Op: "error", ID: in.ID, Error: "invalid subject"})
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.subs[in.Subject]; ok {
		c.sendJSON(wsOut{Op: "subscribed", Subject: in.Subject, ID: in.ID})
		return
	}
	if len(c.subs) >= wsMaxSubs {
		c.sendJSON(wsOut{Op: "error", ID: in.ID, Error: "too many subscriptions"})
		return
	}
	prefixLen := len(c.prefix)
	sub, err := c.srv.bus.Conn().Subscribe(c.prefix+in.Subject, func(m *nats.Msg) {
		c.sendJSON(wsOut{Op: "msg", Subject: m.Subject[prefixLen:], Data: m.Data})
	})
	if err != nil {
		c.sendJSON(wsOut{Op: "error", ID: in.ID, Error: "subscribe failed"})
		return
	}
	c.subs[in.Subject] = sub
	c.sendJSON(wsOut{Op: "subscribed", Subject: in.Subject, ID: in.ID})
}

// unsubscribe confirms with an "unsubscribed" frame; once the client has
// it, no further messages for that subscription will arrive.
func (c *wsConn) unsubscribe(in wsIn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if sub, ok := c.subs[in.Subject]; ok {
		_ = sub.Unsubscribe()
		delete(c.subs, in.Subject)
	}
	c.sendJSON(wsOut{Op: "unsubscribed", Subject: in.Subject, ID: in.ID})
}

func (c *wsConn) unsubscribeAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, sub := range c.subs {
		_ = sub.Unsubscribe()
		delete(c.subs, k)
	}
	for k, wt := range c.watches {
		wt.stop()
		delete(c.watches, k)
	}
}

// watch streams a workspace's new messages and events, if the user can
// see it: the same rule as the read API. It is checked here and again
// whenever the user's access may have changed (recheckWatches).
func (c *wsConn) watch(ctx context.Context, in wsIn) {
	ok, err := c.srv.userCanSeeWorkspace(ctx, c.user, in.Org, in.Workspace)
	if err != nil {
		c.srv.log.Error("watch: access check failed", "err", err)
		c.sendJSON(wsOut{Op: "error", ID: in.ID, Error: "watch failed"})
		return
	}
	if !ok {
		c.sendJSON(wsOut{Op: "error", ID: in.ID, Workspace: in.Workspace, Error: "no such workspace"})
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.watches[in.Workspace]; ok {
		c.sendJSON(wsOut{Op: "watching", ID: in.ID, Workspace: in.Workspace})
		return
	}
	if len(c.watches) >= wsMaxWatches {
		c.sendJSON(wsOut{Op: "error", ID: in.ID, Error: "too many watches"})
		return
	}
	wsID := in.Workspace
	stop, err := c.srv.hub.Watch(ctx, wsID,
		func(seq uint64, data []byte) {
			c.sendJSON(wsOut{Op: "message", Workspace: wsID, Seq: seq, Data: data})
		},
		func(data []byte) { c.sendJSON(wsOut{Op: "event", Workspace: wsID, Data: data}) })
	if err != nil {
		c.srv.log.Error("watch failed", "err", err)
		c.sendJSON(wsOut{Op: "error", ID: in.ID, Error: "watch failed"})
		return
	}
	c.watches[wsID] = watch{org: in.Org, stop: stop}
	c.sendJSON(wsOut{Op: "watching", ID: in.ID, Workspace: wsID})
}

func (c *wsConn) unwatch(in wsIn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if wt, ok := c.watches[in.Workspace]; ok {
		wt.stop()
		delete(c.watches, in.Workspace)
	}
	c.sendJSON(wsOut{Op: "unwatched", ID: in.ID, Workspace: in.Workspace})
}

// watching reports whether the connection watches workspace wsID.
func (c *wsConn) watching(wsID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.watches[wsID]
	return ok
}

// recheckWatches checks every watch against the user's access now and
// stops the ones it no longer allows, at once, telling the client with an
// "unwatched" frame that carries an error. A failed check (database
// unreachable) keeps the watch.
func (c *wsConn) recheckWatches(ctx context.Context) {
	c.mu.Lock()
	snapshot := make(map[string]watch, len(c.watches))
	for id, wt := range c.watches {
		snapshot[id] = wt
	}
	c.mu.Unlock()
	for wsID, wt := range snapshot {
		ok, err := c.srv.userCanSeeWorkspace(ctx, c.user, wt.org, wsID)
		if err != nil {
			c.srv.log.Warn("watch re-check failed; keeping the watch", "workspace", wsID, "err", err)
			continue
		}
		if ok {
			continue
		}
		c.mu.Lock()
		if cur, still := c.watches[wsID]; still {
			cur.stop()
			delete(c.watches, wsID)
			c.sendJSON(wsOut{Op: "unwatched", Workspace: wsID, Error: "access removed"})
		}
		c.mu.Unlock()
	}
}

// browserRegistry holds this node's live browser sockets, so an access
// change can re-check their watches.
type browserRegistry struct {
	mu    sync.Mutex
	conns map[*wsConn]struct{}
}

func (r *browserRegistry) add(c *wsConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.conns[c] = struct{}{}
}

func (r *browserRegistry) remove(c *wsConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.conns, c)
}

func (r *browserRegistry) all() []*wsConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*wsConn, 0, len(r.conns))
	for c := range r.conns {
		out = append(out, c)
	}
	return out
}
