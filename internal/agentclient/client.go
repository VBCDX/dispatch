// Package agentclient is a minimal Go client for Dispatch's agent socket
// (docs/agent-protocol.md). The example agent, the tests and the
// benchmark use it; it is also a reference for other clients.
package agentclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/coder/websocket"

	"github.com/VBCDX/dispatch/internal/messaging"
)

// IDName is an agent or workspace.
type IDName struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Frame is anything the server sends on the agent socket.
type Frame struct {
	Op         string             `json:"op"`
	ID         string             `json:"id,omitempty"`
	Seq        uint64             `json:"seq,omitempty"`
	Message    *messaging.Message `json:"message,omitempty"`
	Error      string             `json:"error,omitempty"`
	Rule       string             `json:"rule,omitempty"`
	Detail     string             `json:"detail,omitempty"`
	Agent      IDName             `json:"agent"`
	Workspace  IDName             `json:"workspace"`
	Read       bool               `json:"read"`
	Write      bool               `json:"write"`
	ResumeFrom uint64             `json:"resume_from,omitempty"`
}

// Client is one agent socket.
type Client struct {
	conn  *websocket.Conn
	Ready Frame // the "ready" frame
	wmu   sync.Mutex
}

// HTTPError is a refused handshake.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("dispatch: %d %s", e.Status, e.Body) }

// WSURL turns a server URL (http or https) into its agent socket URL.
func WSURL(server string) (string, error) {
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("dispatch: server URL must be http or https, got %q", server)
	}
	u.Path += "/agent/v1/ws"
	return u.String(), nil
}

// Dial connects and waits for the ready frame.
func Dial(ctx context.Context, server, agentToken, workspaceToken string) (*Client, error) {
	u, err := WSURL(server)
	if err != nil {
		return nil, err
	}
	h := http.Header{}
	h.Set("Authorization", "Bearer "+agentToken)
	h.Set("X-Dispatch-Workspace-Token", workspaceToken)
	conn, res, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		if res != nil && res.StatusCode != http.StatusSwitchingProtocols {
			var body []byte
			if res.Body != nil {
				body, _ = io.ReadAll(io.LimitReader(res.Body, 4096))
			}
			return nil, &HTTPError{Status: res.StatusCode, Body: strings.TrimSpace(string(body))}
		}
		return nil, err
	}
	conn.SetReadLimit(1 << 20)
	c := &Client{conn: conn}
	f, err := c.Next(ctx)
	if err != nil {
		conn.CloseNow()
		return nil, err
	}
	if f.Op != "ready" {
		conn.CloseNow()
		return nil, fmt.Errorf("dispatch: expected a ready frame, got %q", f.Op)
	}
	c.Ready = f
	return c, nil
}

// Next reads the next frame.
func (c *Client) Next(ctx context.Context) (Frame, error) {
	_, data, err := c.conn.Read(ctx)
	if err != nil {
		return Frame{}, err
	}
	var f Frame
	if err := json.Unmarshal(data, &f); err != nil {
		return Frame{}, fmt.Errorf("dispatch: bad frame: %w", err)
	}
	return f, nil
}

func (c *Client) write(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.conn.Write(ctx, websocket.MessageText, b)
}

// Send sends a message to the workspace, or to a thread when threadID is
// set. The server answers with a "sent" (or "error") frame carrying id.
func (c *Client) Send(ctx context.Context, id, body, threadID string) error {
	return c.write(ctx, map[string]string{"op": "send", "id": id, "body": body, "thread_id": threadID})
}

// Ack acknowledges every delivered message up to and including seq.
func (c *Client) Ack(ctx context.Context, seq uint64) error {
	return c.write(ctx, map[string]any{"op": "ack", "seq": seq})
}

// Close closes the socket normally.
func (c *Client) Close() error { return c.conn.Close(websocket.StatusNormalClosure, "") }

// CloseNow drops the socket without a close handshake, like a crash.
func (c *Client) CloseNow() error { return c.conn.CloseNow() }

// CloseStatus is the close code in err, or -1.
func CloseStatus(err error) int { return int(websocket.CloseStatus(err)) }

// Final reports whether reconnecting cannot help: the server closed with
// 4401 (token revoked), 4403 (access removed) or 4409 (replaced), or
// refused the handshake with 401 or 403.
func Final(err error) bool {
	switch CloseStatus(err) {
	case 4401, 4403, 4409:
		return true
	}
	var he *HTTPError
	return errors.As(err, &he) && (he.Status == http.StatusUnauthorized || he.Status == http.StatusForbidden)
}
