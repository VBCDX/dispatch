package server

import (
	"fmt"
	"slices"

	"github.com/VBCDX/dispatch/internal/store"
)

// The access ladder, as the Access tab shows it (mocks/v1/src/lib/access.ts):
// every agent request to a workspace walks these rules in order and the
// first failure decides. Blocklists sit above membership, so a block always
// wins over anything a workspace grants.

type ladderStep struct {
	Rule   string `json:"rule"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail"`
}

type ladderJSON struct {
	Allowed bool         `json:"allowed"`
	Reason  string       `json:"reason"` // the first failing step's detail
	Steps   []ladderStep `json:"steps"`
}

// accessLadder evaluates op (read, write or admin) for an agent (nil when
// unknown) in a workspace, given its membership there (nil when none).
func accessLadder(a *store.Agent, ws store.Workspace, m *store.WorkspaceMember, op string) ladderJSON {
	step := func(rule string, pass bool, ok, fail string) ladderStep {
		if pass {
			return ladderStep{rule, true, ok}
		}
		return ladderStep{rule, false, fail}
	}
	label := "This agent"
	if a != nil {
		label = a.Label
	}
	steps := []ladderStep{}
	switch {
	case a == nil:
		steps = append(steps, ladderStep{"Agent ID + agent token", false, "Unknown agent ID."})
	default:
		steps = append(steps, step("Agent ID + agent token", a.Status == statusActive, label+" is active.", fmt.Sprintf("%s is %s.", label, a.Status)))
	}
	selfBlock := a != nil && slices.Contains(a.Filters.WorkspaceBlocklist, ws.ID)
	steps = append(steps,
		step("Agent's own workspace blocklist", a != nil && !selfBlock, "Not blocked by the agent.", fmt.Sprintf("%s blocks %s on its own side.", label, ws.Name)),
		step("Workspace agent blocklist", a == nil || !slices.Contains(ws.AgentBlocklist, a.ID), "Not on the workspace blocklist.", ws.Name+" blocks this agent — overrides membership."),
	)
	switch {
	case m == nil:
		steps = append(steps, ladderStep{"Workspace ID + membership token", false, "Not a member of this workspace."})
	case m.TokenRevokedAt != nil:
		steps = append(steps, ladderStep{"Workspace ID + membership token", false, "Its workspace token was revoked."})
	case m.Token == nil:
		steps = append(steps, ladderStep{"Workspace ID + membership token", false, "No workspace token issued yet — create one on the Connect tab."})
	default:
		steps = append(steps, ladderStep{"Workspace ID + membership token", true, "Member, with token ••••" + m.Token.Current.Last4 + "."})
	}
	rule := "Membership allows " + op
	switch {
	case m == nil:
		steps = append(steps, ladderStep{rule, false, "—"})
	case op == "admin":
		steps = append(steps, step(rule, m.EffectiveRole() == store.WSRoleAdmin, "Admin here.", "Member, not admin."))
	default:
		grant := m.Read
		if op == "write" {
			grant = m.Write
		}
		steps = append(steps, step(rule, grant, "Membership grants "+op+".", "Membership doesn't grant "+op+"."))
	}
	rule = "Agent's own filter allows " + op
	if a == nil {
		steps = append(steps, ladderStep{rule, false, "—"})
	} else if op == "read" {
		steps = append(steps, step(rule, a.Filters.Read, label+" allows read.", label+" has turned off reading for itself."))
	} else {
		steps = append(steps, step(rule, a.Filters.Write, label+" allows "+op+".", label+" has turned off writing for itself."))
	}
	out := ladderJSON{Allowed: true, Steps: steps}
	for _, s := range steps {
		if !s.Pass {
			out.Allowed, out.Reason = false, s.Detail
			break
		}
	}
	return out
}
