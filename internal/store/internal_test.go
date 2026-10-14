package store

import (
	"reflect"
	"testing"
)

func TestRebindForPostgres(t *testing.T) {
	pg := &Store{dialect: Postgres}
	if got := pg.q("SELECT a FROM t WHERE b = ? AND c = ?"); got != "SELECT a FROM t WHERE b = $1 AND c = $2" {
		t.Fatalf("postgres rebind = %q", got)
	}
	lite := &Store{dialect: SQLite}
	if got := lite.q("WHERE b = ?"); got != "WHERE b = ?" {
		t.Fatalf("sqlite must keep ?: %q", got)
	}
}

func TestStatementsSplit(t *testing.T) {
	src := "-- a comment; with a semicolon\nCREATE TABLE a (x TEXT);\n\nCREATE INDEX i ON a (x);\n"
	want := []string{"CREATE TABLE a (x TEXT)", "CREATE INDEX i ON a (x)"}
	if got := statements(src); !reflect.DeepEqual(got, want) {
		t.Fatalf("statements = %q, want %q", got, want)
	}
}

func TestMigrationsLoad(t *testing.T) {
	ms, err := loadMigrations()
	if err != nil || len(ms) == 0 || ms[0].version != 1 {
		t.Fatalf("loadMigrations = %+v, %v", ms, err)
	}
}
