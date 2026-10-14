package seed_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/seed"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

// snapshot renders every seeded table's rows as text, so two snapshots
// compare equal only if nothing changed.
func snapshot(t *testing.T, st *store.Store) map[string][]string {
	t.Helper()
	tables, err := seed.Tables()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]string{}
	for _, tb := range tables {
		rows, err := st.DB().QueryContext(context.Background(), "SELECT * FROM "+tb.Name+" ORDER BY 1, 2")
		if err != nil {
			t.Fatalf("%s: %v", tb.Name, err)
		}
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			out[tb.Name] = append(out[tb.Name], fmt.Sprintf("%v", vals))
		}
		rows.Close()
	}
	return out
}

func TestSeedLoadsOnceAndIsIdempotent(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		ctx := context.Background()
		st := storetest.Open(t, b)
		tables, err := seed.Tables()
		if err != nil {
			t.Fatal(err)
		}
		want := 0
		for _, tb := range tables {
			want += len(tb.Rows)
		}

		now := time.Now()
		n, err := seed.Load(ctx, st, now)
		if err != nil {
			t.Fatal(err)
		}
		if n != int64(want) {
			t.Fatalf("first load inserted %d rows, want every fixture row (%d)", n, want)
		}
		before := snapshot(t, st)
		for _, tb := range tables {
			if got := len(before[tb.Name]); got != len(tb.Rows) {
				t.Errorf("%s has %d rows, want %d", tb.Name, got, len(tb.Rows))
			}
		}

		// A second run, later, changes nothing: no inserts, no rewritten times.
		n, err = seed.Load(ctx, st, now.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("second load inserted %d rows, want 0", n)
		}
		after := snapshot(t, st)
		for name, rows := range before {
			if fmt.Sprint(rows) != fmt.Sprint(after[name]) {
				t.Errorf("%s changed on the second load", name)
			}
		}
	})
}

func TestSeedInstantsAreRelativeToLoadTime(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		ctx := context.Background()
		st := storetest.Open(t, b)
		now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
		if _, err := seed.Load(ctx, st, now); err != nil {
			t.Fatal(err)
		}
		// msg_01 was posted three hours before "now" in the mock.
		var created int64
		if err := st.DB().QueryRowContext(ctx, "SELECT created_at FROM messages WHERE id = 'msg_01'").Scan(&created); err != nil {
			t.Fatal(err)
		}
		if got, want := time.UnixMilli(created).UTC(), now.Add(-3*time.Hour); !got.Equal(want) {
			t.Fatalf("msg_01 created_at = %v, want %v", got, want)
		}
		// Instants inside JSON columns are resolved too.
		var attempts string
		if err := st.DB().QueryRowContext(ctx, "SELECT fire_attempts FROM webhooks WHERE id = 'wh_05'").Scan(&attempts); err != nil {
			t.Fatal(err)
		}
		if want := fmt.Sprint(now.Add(-12 * time.Minute).UnixMilli()); !contains(attempts, want) {
			t.Fatalf("fire_attempts = %s, want an attempt at %s", attempts, want)
		}
	})
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
