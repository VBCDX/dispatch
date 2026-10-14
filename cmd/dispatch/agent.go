package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"github.com/VBCDX/dispatch/internal/agentclient"
)

const agentUsage = `usage: dispatch agent demo [--url URL] [--say TEXT]

Runs an example agent. It connects to the workspace its tokens belong to,
prints every message it receives, acknowledges it, and replies in the
thread to each new top-level message from someone else. Replies are never
answered, so two demo agents in one workspace do not loop.

  DISPATCH_AGENT_TOKEN       the agent token (dsp_agent_…), required
  DISPATCH_WORKSPACE_TOKEN   the workspace token (dsp_ws_…), required
  DISPATCH_URL               the server, if --url is not given
`

func agentCmd(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) == 0 || args[0] != "demo" {
		return errors.New(agentUsage)
	}
	fs := flag.NewFlagSet("agent demo", flag.ContinueOnError)
	server := fs.String("url", os.Getenv("DISPATCH_URL"), "the Dispatch server URL (default $DISPATCH_URL)")
	say := fs.String("say", "", "send this message once connected")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	agentTok, wsTok := os.Getenv("DISPATCH_AGENT_TOKEN"), os.Getenv("DISPATCH_WORKSPACE_TOKEN")
	switch {
	case *server == "":
		return errors.New("give --url or set DISPATCH_URL")
	case agentTok == "" || wsTok == "":
		return errors.New("set DISPATCH_AGENT_TOKEN and DISPATCH_WORKSPACE_TOKEN")
	}
	return runDemoAgent(ctx, *server, agentTok, wsTok, *say, stdout)
}

// runDemoAgent connects, and reconnects with a growing delay, until ctx
// ends or the server says reconnecting cannot help.
func runDemoAgent(ctx context.Context, server, agentTok, wsTok, say string, out io.Writer) error {
	delay := time.Second
	for {
		err := demoSession(ctx, server, agentTok, wsTok, &say, out)
		if ctx.Err() != nil {
			return nil
		}
		if agentclient.Final(err) {
			return fmt.Errorf("disconnected for good: %w", err)
		}
		fmt.Fprintf(out, "disconnected (%v); reconnecting in %s\n", err, delay)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
		delay = min(delay*2, 30*time.Second)
	}
}

func demoSession(ctx context.Context, server, agentTok, wsTok string, say *string, out io.Writer) error {
	c, err := agentclient.Dial(ctx, server, agentTok, wsTok)
	if err != nil {
		return err
	}
	defer c.CloseNow()
	me := c.Ready.Agent
	fmt.Fprintf(out, "connected as %s in %s (read %v, write %v, resuming from #%d)\n",
		me.Name, c.Ready.Workspace.Name, c.Ready.Read, c.Ready.Write, c.Ready.ResumeFrom)
	if *say != "" {
		if err := c.Send(ctx, "say", *say, ""); err != nil {
			return err
		}
		*say = "" // once, not on every reconnect
	}
	n := 0
	for {
		f, err := c.Next(ctx)
		if err != nil {
			return err
		}
		switch f.Op {
		case "msg":
			m := f.Message
			where := ""
			if m.ThreadID != "" {
				where = " (in thread " + m.ThreadID + ")"
			}
			fmt.Fprintf(out, "#%d %s %s: %s%s\n", f.Seq, m.Author.Kind, m.Author.Label, m.Body, where)
			if m.ThreadID == "" && !(m.Author.Kind == "agent" && m.Author.ID == me.ID) && c.Ready.Write {
				n++
				reply := fmt.Sprintf("%s here, got it: %q", me.Name, m.Body)
				if err := c.Send(ctx, "r"+strconv.Itoa(n), reply, m.ID); err != nil {
					return err
				}
			}
			if err := c.Ack(ctx, f.Seq); err != nil {
				return err
			}
		case "error":
			fmt.Fprintf(out, "error %s: %s %s\n", f.ID, f.Error, f.Detail)
		}
	}
}
