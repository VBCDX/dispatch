// Command dispatch is the Dispatch server: the API, the web app and the
// agent WebSocket in one binary.
//
//	dispatch [serve]                     run the server (the default)
//	dispatch user create --email E ...   create a local account
//	dispatch healthcheck                 exit 0 if /healthz answers (for containers)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/VBCDX/dispatch/internal/auth"
	"github.com/VBCDX/dispatch/internal/bus"
	"github.com/VBCDX/dispatch/internal/config"
	"github.com/VBCDX/dispatch/internal/seed"
	"github.com/VBCDX/dispatch/internal/server"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/web"
)

const usage = `usage: dispatch [command]

commands:
  serve                                  run the server (the default)
  user create --email EMAIL [--name NAME] [--password-stdin]
                                         create a local account
  seed                                   load the demo data (skips rows that already exist)
  agent demo [--url URL] [--say TEXT]    run an example agent: prints what it receives and
                                         replies in the thread (tokens from DISPATCH_AGENT_TOKEN
                                         and DISPATCH_WORKSPACE_TOKEN)
  healthcheck                            exit 0 if /healthz answers (for containers)
  help, -h, --help                       print this message
`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, serve); err != nil {
		fmt.Fprintln(os.Stderr, "dispatch:", err)
		os.Exit(1)
	}
}

// run dispatches to a subcommand. serve is passed in so tests can check
// which arguments would start the server without starting it.
func run(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer, serve func(context.Context) error) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		return serve(ctx)
	case "user":
		return userCmd(ctx, args, stdin, stdout)
	case "seed":
		return seedCmd(ctx, args, stdout)
	case "agent":
		return agentCmd(ctx, args, stdout)
	case "healthcheck":
		return healthcheck(ctx)
	case "help", "-h", "-help", "--help":
		_, err := io.WriteString(stdout, usage)
		return err
	default:
		return fmt.Errorf("unknown command %q (want serve, user, seed, agent, healthcheck or help)", cmd)
	}
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}

func serve(ctx context.Context) error {
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	log := newLogger(cfg.LogLevel)

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	log.Info("database ready", "dialect", st.Dialect())

	if err := bootstrapAdmin(ctx, st, cfg.Bootstrap, log); err != nil {
		return err
	}
	if cfg.SeedDemoData {
		if err := seedIfEmpty(ctx, st, log); err != nil {
			return err
		}
	}

	b, err := bus.Start(ctx, bus.Options{StoreDir: cfg.NATSStoreDir})
	if err != nil {
		return err
	}
	defer b.Close()
	log.Info("embedded NATS ready", "store_dir", cfg.NATSStoreDir)

	var oidc *auth.OIDC
	if cfg.AuthMode.Zitadel() {
		if cfg.SessionSecret == "" {
			log.Warn("SESSION_SECRET is not set: a Zitadel sign-in in progress fails if Dispatch restarts or another instance takes the callback")
		}
		sealer, err := auth.NewSealer(cfg.SessionSecret)
		if err != nil {
			return err
		}
		oidc = auth.NewOIDC(cfg.OIDC, cfg.SecureCookies(), sealer)
	}

	srv := server.New(cfg, st, b, oidc, web.Dist(), log)
	go srv.RunMaintenance(ctx, 10*time.Minute)
	go srv.RunArchiver(ctx)
	go srv.RunWebhooks(ctx)

	hs := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	ln, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}
	errc := make(chan error, 1)
	go func() { errc <- hs.Serve(ln) }()
	log.Info("dispatch listening", "addr", cfg.ListenAddr, "public_url", cfg.PublicURL.String(), "auth_mode", cfg.AuthMode)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	srv.CloseAgentConnections()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return hs.Shutdown(shutdownCtx)
}

// bootstrapStore is the slice of *store.Store the bootstrap path needs, so the
// lost-race branch below has a deterministic test.
type bootstrapStore interface {
	CountUsers(ctx context.Context) (int, error)
	CreateLocalUser(ctx context.Context, email, name, passwordHash string) (store.User, error)
}

// bootstrapAdmin creates the BOOTSTRAP_ADMIN_* account, but only into an
// empty database, so the variables are safe to leave set but do nothing
// after the first start.
func bootstrapAdmin(ctx context.Context, st bootstrapStore, b config.Bootstrap, log *slog.Logger) error {
	if b.Email == "" {
		return nil
	}
	n, err := st.CountUsers(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		log.Info("BOOTSTRAP_ADMIN_* ignored: users already exist; you can remove these variables")
		return nil
	}
	u, err := createLocalUser(ctx, st, b.Email, b.Name, b.Password)
	if errors.Is(err, store.ErrExists) {
		// Another instance won the concurrent first start (both saw an empty
		// database); the account it created is the one we wanted. The sentinel
		// must survive createLocalUser's wrapping for this branch to fire.
		log.Info("bootstrap account was created by another instance; starting")
		return nil
	}
	if err != nil {
		return fmt.Errorf("bootstrap account: %w", err)
	}
	log.Info("bootstrap account created; remove BOOTSTRAP_ADMIN_PASSWORD from the environment", "user", u.ID)
	return nil
}

func createLocalUser(ctx context.Context, st bootstrapStore, email, name, password string) (store.User, error) {
	email = server.NormalizeEmail(email)
	if !strings.Contains(email, "@") || strings.ContainsAny(email, " \t\r\n") {
		return store.User{}, fmt.Errorf("%q is not an email address", email)
	}
	if err := auth.ValidatePassword(password); err != nil {
		return store.User{}, err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return store.User{}, err
	}
	if name == "" {
		name, _, _ = strings.Cut(email, "@")
	}
	u, err := st.CreateLocalUser(ctx, email, name, hash)
	if errors.Is(err, store.ErrExists) {
		// Keep the sentinel in the chain: bootstrapAdmin's lost-race branch
		// depends on errors.Is(err, store.ErrExists).
		return store.User{}, fmt.Errorf("a local account for %s already exists: %w", email, store.ErrExists)
	}
	return u, err
}

func userCmd(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) == 0 || args[0] != "create" {
		return errors.New("usage: dispatch user create --email EMAIL [--name NAME] [--password-stdin]")
	}
	fs := flag.NewFlagSet("user create", flag.ContinueOnError)
	email := fs.String("email", "", "email address (required)")
	name := fs.String("name", "", "display name (defaults to the part before @)")
	fromStdin := fs.Bool("password-stdin", false, "read the password from standard input instead of prompting")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *email == "" {
		return errors.New("--email is required")
	}
	password, err := readPassword(stdin, stdout, *fromStdin)
	if err != nil {
		return err
	}

	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	u, err := createLocalUser(ctx, st, *email, *name, password)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "created %s (%s)\n", u.Email, u.ID)
	return nil
}

// seedIfEmpty loads the demo data when the database has no organizations.
func seedIfEmpty(ctx context.Context, st *store.Store, log *slog.Logger) error {
	n, err := st.CountOrgs(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		log.Info("SEED_DEMO_DATA is on but the database already has organizations; not seeding")
		return nil
	}
	rows, err := seed.Load(ctx, st, time.Now())
	if err != nil {
		return err
	}
	log.Info("loaded demo data", "rows", rows, "org", seed.DemoOrgID)
	return nil
}

func seedCmd(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) > 0 {
		return errors.New("usage: dispatch seed")
	}
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	rows, err := seed.Load(ctx, st, time.Now())
	if err != nil {
		return err
	}
	if rows == 0 {
		fmt.Fprintln(stdout, "demo data already loaded; nothing to do")
		return nil
	}
	fmt.Fprintf(stdout, "loaded demo data: %d rows\n", rows)
	return nil
}

func healthcheck(ctx context.Context) error {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/healthz", nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned %s", res.Status)
	}
	return nil
}
