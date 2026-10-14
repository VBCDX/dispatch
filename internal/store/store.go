// Package store is Dispatch's system of record: users, identities and
// sessions, the shared suite records (orgs, workspaces, memberships, agents,
// audit) and Dispatch's own configuration and message history. One set of
// queries and one migration set serve both Postgres and SQLite; the
// database is picked by the DATABASE_URL scheme.
//
// Nothing in this package is on the agent message path: messages go through
// NATS (see internal/bus), never through SQL.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" driver
	_ "modernc.org/sqlite"             // registers the "sqlite" driver
)

// Dialect is the SQL database behind a Store.
type Dialect string

const (
	Postgres Dialect = "postgres"
	SQLite   Dialect = "sqlite"
)

var (
	// ErrNotFound is returned when a row does not exist (or a session has expired).
	ErrNotFound = errors.New("store: not found")
	// ErrExists is returned when creating something whose unique key is taken.
	ErrExists = errors.New("store: already exists")
)

// Store wraps a database handle with Dispatch's queries.
type Store struct {
	db      *sql.DB
	dialect Dialect
}

// execer is implemented by *sql.DB and *sql.Tx, so a helper can run both on
// the pool and inside a transaction (materializeSettings does).
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Open connects to the database named by rawURL and applies pending migrations.
//
//	postgres://user:pass@host:5432/db?sslmode=disable  (or postgresql://)
//	sqlite://data/dispatch.db                          (relative path)
//	sqlite:///var/lib/dispatch/dispatch.db             (absolute path)
func Open(ctx context.Context, rawURL string) (*Store, error) {
	s, err := open(rawURL)
	if err != nil {
		return nil, err
	}
	if err := s.db.PingContext(ctx); err != nil {
		s.db.Close()
		return nil, fmt.Errorf("store: connect %s: %w", s.dialect, err)
	}
	if err := s.migrate(ctx); err != nil {
		s.db.Close()
		return nil, err
	}
	return s, nil
}

func open(rawURL string) (*Store, error) {
	switch {
	case strings.HasPrefix(rawURL, "postgres://"), strings.HasPrefix(rawURL, "postgresql://"):
		db, err := sql.Open("pgx", rawURL)
		if err != nil {
			return nil, fmt.Errorf("store: %w", err)
		}
		return &Store{db: db, dialect: Postgres}, nil
	case strings.HasPrefix(rawURL, "sqlite://"):
		path := strings.TrimPrefix(rawURL, "sqlite://")
		if i := strings.IndexByte(path, '?'); i >= 0 {
			path = path[:i]
		}
		if path == "" {
			return nil, errors.New("store: sqlite URL has no file path")
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return nil, fmt.Errorf("store: create sqlite directory: %w", err)
		}
		q := url.Values{}
		for _, p := range []string{"busy_timeout(5000)", "journal_mode(WAL)", "synchronous(NORMAL)", "foreign_keys(1)"} {
			q.Add("_pragma", p)
		}
		// BEGIN IMMEDIATE takes the write lock up front, so a transaction that
		// reads then writes waits on busy_timeout instead of failing with
		// SQLITE_BUSY when another writer got there first.
		q.Set("_txlock", "immediate")
		db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
		if err != nil {
			return nil, fmt.Errorf("store: %w", err)
		}
		return &Store{db: db, dialect: SQLite}, nil
	default:
		return nil, errors.New("store: DATABASE_URL must start with postgres://, postgresql:// or sqlite://")
	}
}

// Dialect reports which database is in use.
func (s *Store) Dialect() Dialect { return s.dialect }

// DB returns the underlying handle, for tests and tooling that need raw
// SQL. Application code uses the Store's methods.
func (s *Store) DB() *sql.DB { return s.db }

// Close closes the database handle.
func (s *Store) Close() error { return s.db.Close() }

// Ping checks the database is reachable; used by /readyz.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// q rewrites ? placeholders to $1, $2, … for Postgres. Queries in this
// package never contain a literal question mark.
func (s *Store) q(query string) string {
	if s.dialect != Postgres {
		return query
	}
	var b strings.Builder
	n := 0
	for _, r := range query {
		if r == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// NewID returns a schema-style public ID: prefix, "_", then 16 random base62
// characters (about 95 bits), e.g. NewID("ws") = "ws_3fK9qLm0ZtR8bW2x".
func NewID(prefix string) string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	b := make([]byte, 0, len(prefix)+17)
	b = append(b, prefix...)
	b = append(b, '_')
	for _, c := range buf {
		// 248 = 4 × 62: reject the top values so every character is equally likely.
		for c >= 248 {
			var one [1]byte
			if _, err := rand.Read(one[:]); err != nil {
				panic(err)
			}
			c = one[0]
		}
		b = append(b, base62[c%62])
	}
	return string(b)
}

func millis(t time.Time) int64 { return t.UnixMilli() }

func fromMillis(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

// User is a Dispatch account.
type User struct {
	ID        string
	Email     string
	Name      string
	CreatedAt time.Time
}

// Identity providers, as in the shared auth schema. A password identity has
// an empty connection_id and subject = the lower-cased email; an OIDC
// identity has connection_id = the issuer URL and subject = the token's
// "sub".
const (
	ProviderPassword = "password"
	ProviderOIDC     = "oidc"
)

// CountUsers returns how many users exist.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM users").Scan(&n)
	return n, err
}

// CreateLocalUser creates a user with an email-and-password identity. The
// email must already be normalised (trimmed and lower-cased). It returns
// ErrExists if a local account with that email already exists.
func (s *Store) CreateLocalUser(ctx context.Context, email, name, passwordHash string) (User, error) {
	now := time.Now()
	u := User{ID: NewID("u"), Email: email, Name: name, CreatedAt: now.UTC()}
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := insertUser(ctx, tx, s, u.ID, email, name, now); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, s.q(
			`INSERT INTO identities (id, user_id, provider, connection_id, subject, email_at_link, password_hash, linked_at)
			 VALUES (?, ?, ?, '', ?, ?, ?, ?)
			 ON CONFLICT (provider, connection_id, subject) DO NOTHING`),
			NewID("idn"), u.ID, ProviderPassword, email, email, passwordHash, millis(now))
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil {
			return err
		} else if n == 0 {
			return ErrExists
		}
		return nil
	})
	if err != nil {
		return User{}, err
	}
	return u, nil
}

// LocalCredentials returns the user ID and password hash for a local account.
func (s *Store) LocalCredentials(ctx context.Context, email string) (userID, passwordHash string, err error) {
	var hash sql.NullString
	err = s.db.QueryRowContext(ctx, s.q(
		"SELECT user_id, password_hash FROM identities WHERE provider = ? AND connection_id = '' AND subject = ?"),
		ProviderPassword, email).Scan(&userID, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	return userID, hash.String, nil
}

// TouchLocalIdentity records a successful local sign-in.
func (s *Store) TouchLocalIdentity(ctx context.Context, email string) error {
	_, err := s.db.ExecContext(ctx, s.q(
		"UPDATE identities SET last_used_at = ? WHERE provider = ? AND connection_id = '' AND subject = ?"),
		millis(time.Now()), ProviderPassword, email)
	return err
}

// UpsertOIDCUser finds the user linked to issuer+subject, creating the user
// and identity on first sign-in. Email and name are refreshed from the
// provider on every sign-in. Users are linked by issuer and subject only,
// never by email: an email match is not proof the same person owns both.
func (s *Store) UpsertOIDCUser(ctx context.Context, issuer, subject, email, name string) (User, error) {
	for attempt := 0; attempt < 2; attempt++ {
		u, err := s.upsertOIDCUser(ctx, issuer, subject, email, name)
		if !errors.Is(err, ErrExists) {
			return u, err
		}
		// A concurrent first sign-in created the identity; the retry finds it.
	}
	return User{}, fmt.Errorf("store: could not link identity %s/%s", issuer, subject)
}

func (s *Store) upsertOIDCUser(ctx context.Context, issuer, subject, email, name string) (User, error) {
	now := time.Now()
	var u User
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var userID string
		err := tx.QueryRowContext(ctx, s.q(
			"SELECT user_id FROM identities WHERE provider = ? AND connection_id = ? AND subject = ?"),
			ProviderOIDC, issuer, subject).Scan(&userID)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			userID = NewID("u")
			if err := insertUser(ctx, tx, s, userID, email, name, now); err != nil {
				return err
			}
			res, err := tx.ExecContext(ctx, s.q(
				`INSERT INTO identities (id, user_id, provider, connection_id, subject, email_at_link, linked_at, last_used_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (provider, connection_id, subject) DO NOTHING`),
				NewID("idn"), userID, ProviderOIDC, issuer, subject, nullable(email), millis(now), millis(now))
			if err != nil {
				return err
			}
			if n, err := res.RowsAffected(); err != nil {
				return err
			} else if n == 0 {
				return ErrExists
			}
		case err != nil:
			return err
		default:
			if _, err := tx.ExecContext(ctx, s.q(
				"UPDATE users SET email = ?, email_lower = ?, name = ?, updated_at = ? WHERE id = ?"),
				email, strings.ToLower(email), name, millis(now), userID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, s.q(
				"UPDATE identities SET last_used_at = ? WHERE provider = ? AND connection_id = ? AND subject = ?"),
				millis(now), ProviderOIDC, issuer, subject); err != nil {
				return err
			}
		}
		u, err = getUser(ctx, tx, s, userID)
		return err
	})
	return u, err
}

func insertUser(ctx context.Context, tx *sql.Tx, s *Store, id, email, name string, now time.Time) error {
	_, err := tx.ExecContext(ctx, s.q(
		`INSERT INTO users (id, email, email_lower, name, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'active', ?, ?)`),
		id, email, strings.ToLower(email), name, millis(now), millis(now))
	return err
}

// GetUser loads a user by ID.
func (s *Store) GetUser(ctx context.Context, id string) (User, error) {
	return getUser(ctx, s.db, s, id)
}

type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func getUser(ctx context.Context, db queryer, s *Store, id string) (User, error) {
	var u User
	var created int64
	err := db.QueryRowContext(ctx, s.q("SELECT id, email, name, created_at FROM users WHERE id = ?"), id).
		Scan(&u.ID, &u.Email, &u.Name, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	u.CreatedAt = fromMillis(created)
	return u, err
}

// RecordSignIn stamps the user's last sign-in and reports whether it was
// their first. Of two concurrent first sign-ins, exactly one reports first.
func (s *Store) RecordSignIn(ctx context.Context, userID string, now time.Time) (first bool, err error) {
	res, err := s.db.ExecContext(ctx, s.q(
		"UPDATE users SET last_sign_in_at = ? WHERE id = ? AND last_sign_in_at IS NULL"), millis(now), userID)
	if err != nil {
		return false, err
	}
	if n, err := res.RowsAffected(); err != nil || n == 1 {
		return n == 1, err
	}
	_, err = s.db.ExecContext(ctx, s.q("UPDATE users SET last_sign_in_at = ? WHERE id = ?"), millis(now), userID)
	return false, err
}

// Org roles, as in the shared auth schema.
const (
	RoleOwner     = "Owner"
	RoleUserAdmin = "userAdmin"
	RoleUser      = "user"
)

// JoinOrg makes the user an active member of the org with the given role,
// unless they already have a membership there (which is left as it is).
// It reports whether it added one. A missing or deleted org is ErrNotFound.
func (s *Store) JoinOrg(ctx context.Context, orgID, userID, role string, now time.Time) (bool, error) {
	var added bool
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var one int
		err := tx.QueryRowContext(ctx, s.q("SELECT 1 FROM orgs WHERE id = ? AND status = 'active'"), orgID).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, s.q(
			`INSERT INTO org_memberships (id, org_id, user_id, role, status, joined_at, created_at, updated_at, rev)
			 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 0)
			 ON CONFLICT (org_id, user_id) DO NOTHING`),
			NewID("om"), orgID, userID, role, millis(now), millis(now), millis(now))
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		added = n == 1
		return err
	})
	return added, err
}

// CountOrgs returns how many organizations exist, deleted ones included.
func (s *Store) CountOrgs(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM orgs").Scan(&n)
	return n, err
}

// Session is a signed-in browser session.
type Session struct {
	IDHash      string // SHA-256 of the cookie value, hex encoded
	UserID      string
	Method      string // "local" or "zitadel"
	CSRFToken   string
	IDTokenHint string // the OIDC ID token, sent back to the provider on sign-out
	// For a Zitadel session: the ID token's issuer, subject and session ID
	// ("sid"), which a back-channel logout token names.
	OIDCIssuer  string
	OIDCSubject string
	OIDCSID     string
	CreatedAt   time.Time
	ExpiresAt   time.Time
}

// CreateSession stores a new session. last_seen_at starts at created_at: the
// migration backfills existing rows the same way, and nothing touches the
// column yet, so a new session must not be listed as last seen in 1970 with
// the column's DEFAULT 0.
func (s *Store) CreateSession(ctx context.Context, sess Session) error {
	_, err := s.db.ExecContext(ctx, s.q(
		`INSERT INTO sessions (id_hash, user_id, method, csrf_token, id_token_hint, oidc_issuer, oidc_subject, oidc_sid, created_at, last_seen_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		sess.IDHash, sess.UserID, sess.Method, sess.CSRFToken, nullable(sess.IDTokenHint),
		nullable(sess.OIDCIssuer), nullable(sess.OIDCSubject), nullable(sess.OIDCSID),
		millis(sess.CreatedAt), millis(sess.CreatedAt), millis(sess.ExpiresAt))
	return err
}

// GetSession loads an unexpired session and its user. Expired, revoked or
// unknown sessions return ErrNotFound.
func (s *Store) GetSession(ctx context.Context, idHash string, now time.Time) (Session, User, error) {
	var sess Session
	var u User
	var hint, iss, sub, sid sql.NullString
	var created, expires, userCreated int64
	err := s.db.QueryRowContext(ctx, s.q(
		`SELECT s.id_hash, s.user_id, s.method, s.csrf_token, s.id_token_hint,
		        s.oidc_issuer, s.oidc_subject, s.oidc_sid, s.created_at, s.expires_at,
		        u.id, u.email, u.name, u.created_at
		   FROM sessions s JOIN users u ON u.id = s.user_id
		  WHERE s.id_hash = ? AND s.expires_at > ? AND s.revoked_at IS NULL`), idHash, millis(now)).
		Scan(&sess.IDHash, &sess.UserID, &sess.Method, &sess.CSRFToken, &hint, &iss, &sub, &sid, &created, &expires,
			&u.ID, &u.Email, &u.Name, &userCreated)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, User{}, ErrNotFound
	}
	if err != nil {
		return Session{}, User{}, err
	}
	sess.IDTokenHint, sess.OIDCIssuer, sess.OIDCSubject, sess.OIDCSID = hint.String, iss.String, sub.String, sid.String
	sess.CreatedAt, sess.ExpiresAt, u.CreatedAt = fromMillis(created), fromMillis(expires), fromMillis(userCreated)
	return sess, u, nil
}

// DeleteSession removes a session; deleting a missing session is not an error.
func (s *Store) DeleteSession(ctx context.Context, idHash string) error {
	_, err := s.db.ExecContext(ctx, s.q("DELETE FROM sessions WHERE id_hash = ?"), idHash)
	return err
}

// DeleteExpiredSessions removes sessions that expired before now, and the
// back-channel logout token IDs that no longer need remembering.
func (s *Store) DeleteExpiredSessions(ctx context.Context, now time.Time) (int64, error) {
	if _, err := s.db.ExecContext(ctx, s.q("DELETE FROM oidc_logout_tokens WHERE expires_at <= ?"), millis(now)); err != nil {
		return 0, err
	}
	res, err := s.db.ExecContext(ctx, s.q("DELETE FROM sessions WHERE expires_at <= ?"), millis(now))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ErrReplayed is returned when a back-channel logout token was already used.
var ErrReplayed = errors.New("store: logout token already used")

// LogoutToken is a verified back-channel logout token: which provider
// session (SID) or user (Subject) at Issuer to sign out.
type LogoutToken struct {
	Issuer    string
	TokenID   string // "jti"
	Expires   time.Time
	SessionID string // "sid"; may be empty
	Subject   string // "sub"; may be empty when SessionID is set
}

// BackchannelLogout records the token's ID and deletes the sessions it
// names, in one transaction: every session with its sid, or, without a sid,
// every session for its subject. With both, a session must match both.
// It returns the deleted sessions' ID hashes, or ErrReplayed if the token
// ID was seen before (nothing is deleted then).
func (s *Store) BackchannelLogout(ctx context.Context, t LogoutToken) ([]string, error) {
	if t.SessionID == "" && t.Subject == "" {
		return nil, errors.New("store: logout token names neither a session nor a subject")
	}
	var deleted []string
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(
			`INSERT INTO oidc_logout_tokens (issuer, jti, expires_at) VALUES (?, ?, ?)
			 ON CONFLICT (issuer, jti) DO NOTHING`), t.Issuer, t.TokenID, millis(t.Expires))
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil {
			return err
		} else if n == 0 {
			return ErrReplayed
		}

		where, args := "oidc_issuer = ?", []any{t.Issuer}
		if t.SessionID != "" {
			where, args = where+" AND oidc_sid = ?", append(args, t.SessionID)
		}
		if t.Subject != "" {
			where, args = where+" AND oidc_subject = ?", append(args, t.Subject)
		}
		rows, err := tx.QueryContext(ctx, s.q("DELETE FROM sessions WHERE "+where+" RETURNING id_hash"), args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			deleted = append(deleted, id)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return deleted, nil
}

func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func (s *Store) inTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}
