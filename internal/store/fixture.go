package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// FixtureTable is a batch of rows for one table, as loaded from a JSON
// fixture: column name to value. A JSON object {"$t": ms} is an instant ms
// milliseconds from the load time; any other object or array is stored as
// JSON text (for jsonb columns).
type FixtureTable struct {
	Name string           `json:"name"`
	Rows []map[string]any `json:"rows"`
}

var identifier = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// LoadFixture inserts every row whose key is not already taken, in one
// transaction, and reports how many rows it inserted. Loading the same
// fixture twice inserts nothing the second time: rows are never updated.
func (s *Store) LoadFixture(ctx context.Context, tables []FixtureTable, now time.Time) (int64, error) {
	var inserted int64
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		for _, t := range tables {
			if !identifier.MatchString(t.Name) {
				return fmt.Errorf("store: fixture table name %q", t.Name)
			}
			for i, row := range t.Rows {
				cols := make([]string, 0, len(row))
				for c := range row {
					if !identifier.MatchString(c) {
						return fmt.Errorf("store: fixture %s row %d: column name %q", t.Name, i, c)
					}
					cols = append(cols, c)
				}
				sort.Strings(cols)
				args := make([]any, len(cols))
				for j, c := range cols {
					v, err := fixtureValue(row[c], now)
					if err != nil {
						return fmt.Errorf("store: fixture %s row %d column %s: %w", t.Name, i, c, err)
					}
					args[j] = v
				}
				query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s) ON CONFLICT DO NOTHING",
					t.Name, strings.Join(cols, ", "), strings.TrimSuffix(strings.Repeat("?, ", len(cols)), ", "))
				res, err := tx.ExecContext(ctx, s.q(query), args...)
				if err != nil {
					return fmt.Errorf("store: fixture %s row %d: %w", t.Name, i, err)
				}
				n, err := res.RowsAffected()
				if err != nil {
					return err
				}
				inserted += n
			}
		}
		return nil
	})
	return inserted, err
}

// fixtureValue converts a decoded JSON value to a database argument.
func fixtureValue(v any, now time.Time) (any, error) {
	switch x := v.(type) {
	case nil, string, bool:
		return x, nil
	case float64:
		if x == math.Trunc(x) && math.Abs(x) < 1<<53 {
			return int64(x), nil
		}
		return x, nil
	case map[string]any:
		if t, ok := instant(x, now); ok {
			return t, nil
		}
	}
	b, err := json.Marshal(resolveInstants(v, now))
	if err != nil {
		return nil, err
	}
	return string(b), nil
}

// instant reports whether m is {"$t": ms} and returns now + ms in Unix ms.
func instant(m map[string]any, now time.Time) (int64, bool) {
	if len(m) != 1 {
		return 0, false
	}
	ms, ok := m["$t"].(float64)
	if !ok {
		return 0, false
	}
	return now.UnixMilli() + int64(ms), true
}

// resolveInstants replaces every {"$t": ms} inside a JSON value.
func resolveInstants(v any, now time.Time) any {
	switch x := v.(type) {
	case map[string]any:
		if t, ok := instant(x, now); ok {
			return t
		}
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = resolveInstants(e, now)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = resolveInstants(e, now)
		}
		return out
	default:
		return v
	}
}
