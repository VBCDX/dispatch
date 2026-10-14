package store

import (
	"encoding/json"
	"time"
)

// The read models below are what the screens need from each table (see
// docs/data-model.md). Token hashes and sealed secrets are never read into
// them: a token shows as its prefix and last four characters only.

// Principal is who created or changed something: a user, agent, support
// operator or system job. It grants nothing.
type Principal struct {
	Kind string // user, agent, support or system
	ID   string
}

// Actor is who did something, as recorded at the time: the label is a
// snapshot, so later renames don't rewrite history.
type Actor struct {
	Kind  string // user, agent, support, system, connector, sidecar or listener
	ID    string // empty for system actors
	Label string
	Via   *ActorVia
}

// ActorVia is the channel an actor used, such as the API console (a human
// using an agent's credentials) or a sidecar.
type ActorVia struct {
	Kind  string // sidecar, api_console, cli or connector
	ID    string
	Label string
}

// TokenInfo is what can be shown of a stored token.
type TokenInfo struct {
	Prefix   string // e.g. dsp_agent_
	Last4    string
	IssuedAt time.Time
}

// Credential is a rotating token: the current one, and the previous one
// while its grace period runs.
type Credential struct {
	Current       TokenInfo
	Previous      *TokenInfo
	PreviousUntil *time.Time
	RotatedAt     *time.Time
}

// Org is an organization.
type Org struct {
	ID                 string
	Name               string
	Status             string // active or deleted
	AuditRetentionDays *int
	CreatedAt          time.Time
	CreatedBy          Principal
	UpdatedAt          time.Time
	DeletedAt          *time.Time
	Rev                int
}

// OrgMembership is a user's role and status in one org.
type OrgMembership struct {
	ID            string
	OrgID         string
	UserID        string
	Role          string // Owner, userAdmin or user
	Status        string // active, invited or suspended
	SuspendedFrom string // while suspended: active or invited
	JoinedAt      *time.Time
	CreatedAt     time.Time
}

// OrgMember is a row on the People screen.
type OrgMember struct {
	OrgMembership
	Name       string
	Email      string
	UserStatus string // active, or pending (never signed in)
}

// UserOrg is an org in a user's org switcher.
type UserOrg struct {
	Org
	Role   string
	Status string
}

// Workspace is a shared workspace with Dispatch's settings.
type Workspace struct {
	ID                 string
	OrgID              string
	Name               string
	Status             string // active or deleted
	Description        string
	DefaultExpiryHours *int // nil: messages don't expire by default
	RetentionDays      int
	AgentBlocklist     []string // agents that may never act here
	CreatedAt          time.Time
	CreatedBy          Principal
	UpdatedAt          time.Time
	DeletedAt          *time.Time
	DeletedBy          *Principal
	Rev                int
}

// WorkspaceMember is a membership with its Dispatch access settings.
type WorkspaceMember struct {
	ID          string
	OrgID       string
	WorkspaceID string
	Member      Principal // kind user or agent
	Role        string    // shared role: member or workspace_admin
	AddedAt     time.Time
	AddedBy     Principal
	DelegatedBy *Principal
	DelegatedAt *time.Time
	Read        bool
	Write       bool
	// AgentRole is Dispatch's agent workspace admin (agents only).
	AgentRole      string
	Token          *Credential // agents only: the dsp_ws_ token
	TokenRevokedAt *time.Time
	TokenDelivery  string
}

// AgentFilters are an agent's own refusals.
type AgentFilters struct {
	Read               bool
	Write              bool
	WorkspaceBlocklist []string
	AgentBlocklist     []string
}

// AgentClient is what an agent reported about itself when it connected.
type AgentClient struct {
	Name    string
	Version string
	Via     string // MCP or REST
	At      *time.Time
}

// Agent is the shared agent identity with Dispatch's profile.
type Agent struct {
	ID              string
	OrgID           string
	Label           string
	CreatedAt       time.Time
	CreatedBy       Principal
	CreatedByLabel  string
	RetiredAt       *time.Time
	Status          string // active, suspended or revoked
	Description     string
	Token           Credential
	TokenDelivery   string
	Filters         AgentFilters
	Client          *AgentClient
	LastTransport   string // MCP or REST
	LastTransportAt *time.Time
	LastSeenAt      *time.Time
	ConfigFormat    string
	SuspendedAt     *time.Time
	RevokedAt       *time.Time
}

// Author is who wrote a message: a user, an agent, or an outside system
// calling the message's listener (From is its address).
type Author struct {
	Kind string // user, agent or listener
	ID   string
	From string
}

// MessageBody is a message's text, inline or (over 64 KiB) in a blob with
// an inline preview.
type MessageBody struct {
	Storage string // inline or blob
	Text    string
	BlobID  string
	Bytes   int64
	Preview string
}

// Audience is who a message is addressed to.
type Audience struct {
	Mode     string   // all, only or except
	AgentIDs []string // for only and except
}

// ReceiptCounts is the per-state receipt snapshot kept on a message.
// Delivered counts read and acked receipts too, and read counts acked.
type ReceiptCounts struct {
	Targets, Queued, Held, Delivered, Read, Acked, Filtered, NeverDelivered int
}

// Message is one message in a workspace.
type Message struct {
	ID            string
	OrgID         string
	WorkspaceID   string
	Author        Author
	Body          MessageBody
	Payload       json.RawMessage // inline JSON payload, if any
	PayloadBlobID string
	Tags          []string
	Audience      Audience
	ParentID      string
	ThreadRootID  string
	CreatedAt     time.Time
	ExpiresAt     *time.Time
	ExpiredEarly  *time.Time
	Trk           string
	SentVia       string // api_console or sidecar
	SentViaID     string // the user (api_console) or sidecar
	WebhookID     string
	ReceiptCounts ReceiptCounts
	// StreamSeq is the message's JetStream stream sequence (0 for messages
	// that never went through the stream, such as demo data).
	StreamSeq uint64
}

// Receipt is one targeted agent's delivery state for a message.
type Receipt struct {
	ID                string
	OrgID             string
	WorkspaceID       string
	MessageID         string
	AgentID           string
	State             string // queued, held, delivered, read, acked, filtered or never_delivered
	DeliveredAt       *time.Time
	ReadAt            *time.Time
	AckAt             *time.Time
	DeliveredVia      string
	HeldRule          string
	HeldCause         string
	HeldAt            *time.Time
	FilteredRule      string
	FilteredCause     string
	FilteredAt        *time.Time
	FilteredAfterSend bool
	Removed           *ReceiptRemoved
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// ReceiptRemoved notes that access was removed after delivery. The
// receipt keeps what it recorded.
type ReceiptRemoved struct {
	At     time.Time
	Reason string
	Final  bool
	Cause  string
}

// Thread is the summary kept on a root message.
type Thread struct {
	RootID       string
	OrgID        string
	WorkspaceID  string
	ReplyCount   int
	LastReplyAt  *time.Time
	Participants []Author
	UpdatedAt    time.Time
}

// Tag is a workspace's tag with its use count.
type Tag struct {
	Tag          string
	MessageCount int
	LastUsedAt   time.Time
}

// ContextNote is a versioned note pinned to a workspace.
type ContextNote struct {
	ID          string
	OrgID       string
	WorkspaceID string
	Title       string
	Body        string
	Tags        []string
	Version     int
	CreatedAt   time.Time
	CreatedBy   Actor
	UpdatedAt   time.Time
	UpdatedBy   Actor
	DeletedAt   *time.Time
}

// ContextNoteVersion is one immutable version of a note.
type ContextNoteVersion struct {
	NoteID  string
	Version int
	Title   string
	Body    string
	Tags    []string
	At      time.Time
	By      Actor
}

// WebhookAttempt is one delivery attempt of a fire hook.
type WebhookAttempt struct {
	ID     string `json:"id"`
	At     int64  `json:"at"` // Unix ms
	Status int    `json:"status"`
	MS     int    `json:"ms"`
	Trk    string `json:"trk"`
	Note   string `json:"note,omitempty"`
	Manual bool   `json:"manual,omitempty"`
}

// WebhookDropped is a target that could no longer meet a fire trigger.
type WebhookDropped struct {
	AgentID string `json:"agentId"`
	Cause   string `json:"cause"`
	Reason  string `json:"reason"`
	At      int64  `json:"at"` // Unix ms
}

// Webhook is a message's fire hook or listener.
type Webhook struct {
	ID          string
	OrgID       string
	WorkspaceID string
	MessageID   string
	Mode        string // fire or listen
	Fire        *FireHook
	Listen      *Listener
	CreatedAt   time.Time
	CreatedBy   Actor
	UpdatedAt   time.Time
	ExpiresAt   *time.Time
}

// FireHook is an outbound webhook. The basic-auth password is never read:
// HasPassword says whether one is set.
type FireHook struct {
	URL           string
	Trigger       string // send, all-read or all-ack
	AuthUser      string
	HasPassword   bool
	DeliveryMode  string // push or sidecar_pull
	SidecarID     string
	State         string // waiting, retrying, delivered, gave_up, no_targets, expired or target_lost
	FiredAt       *time.Time
	NextAttemptAt *time.Time
	AttemptCount  int
	Attempts      []WebhookAttempt
	OutcomeAt     *time.Time
	Dropped       []WebhookDropped
}

// Listener is an inbound webhook URL.
type Listener struct {
	ListenerID string
	URL        string
	User       string
	Password   TokenInfo
	State      string // open or closed
	CallCount  int
	LastCallAt *time.Time
}

// ListenerCall is one call to a listener URL.
type ListenerCall struct {
	ID                string
	WebhookID         string
	ListenerID        string
	MessageID         string
	At                time.Time
	Status            int
	FromIP            string
	Bytes             int64
	AppendedMessageID string
	Trk               string
	Summary           string
}

// DeadLetter is a fire hook that gave up.
type DeadLetter struct {
	ID          string
	WorkspaceID string
	WebhookID   string
	MessageID   string
	URL         string
	Trigger     string
	Attempts    []WebhookAttempt
	Reason      string // gave_up or sidecar_unavailable
	DeadAt      time.Time
}

// Sidecar is a local process bound to one agent.
type Sidecar struct {
	ID           string
	OrgID        string
	AgentID      string
	Name         string
	Status       string // active or revoked
	Credential   Credential
	HealthStatus string // healthy, degraded or offline
	LastSeenAt   *time.Time
	Version      string
	CreatedAt    time.Time
	RevokedAt    *time.Time
}

// AuditEvent is one row of the audit log, shared or Dispatch's own.
type AuditEvent struct {
	ID          string
	OrgID       string
	WorkspaceID string
	App         string
	Shared      bool
	Type        string
	Severity    string
	At          time.Time
	Actor       Actor
	Subject     *AuditSubject
	Object      string
	Result      string
	Reason      string
	Trk         string
	Changes     json.RawMessage // shared rows: [{field, before, after}]
	Detail      json.RawMessage // dispatch/audit_detail.schema.json
	LinkLabel   string
	LinkTo      string
}

// AuditSubject is what an audit row is about.
type AuditSubject struct {
	Kind  string
	ID    string
	Label string
}

// Notifications are the five "notify me when" switches.
type Notifications struct {
	WebhookFailing  bool
	BlockedAttempt  bool
	MessageExpiring bool
	AgentOffline    bool
	MemberAdded     bool
}

// OrgSettings are Dispatch's per-org settings.
type OrgSettings struct {
	OrgID               string
	Notifications       Notifications // the org's defaults
	DefaultGraceSeconds *int
	UpdatedAt           time.Time
}

// UserSession is one of a user's live sessions, for My Settings.
type UserSession struct {
	Method     string
	Client     string
	Device     string
	Place      string
	CreatedAt  time.Time
	LastSeenAt time.Time
	ExpiresAt  time.Time
}
