// Package seed holds the demo database: the mock's populated demo data
// (mocks/v1/src/lib/seed.ts), converted to Dispatch's tables by
// scripts/seed-from-mock.mjs and embedded in the binary.
package seed

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"time"

	"github.com/VBCDX/dispatch/internal/store"
)

// DemoOrgID is the demo organization people join when demo data is on.
const DemoOrgID = "org_acme"

//go:embed demo.json
var demoJSON []byte

type fixture struct {
	Comment string               `json:"$comment"`
	Tables  []store.FixtureTable `json:"tables"`
}

// Tables decodes the embedded demo fixture.
func Tables() ([]store.FixtureTable, error) {
	var f fixture
	dec := json.NewDecoder(bytes.NewReader(demoJSON))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("seed: demo.json: %w", err)
	}
	return f.Tables, nil
}

// Load inserts the demo data, skipping any row whose key already exists,
// and returns how many rows it inserted. A second run inserts nothing.
func Load(ctx context.Context, st *store.Store, now time.Time) (int64, error) {
	tables, err := Tables()
	if err != nil {
		return 0, err
	}
	return st.LoadFixture(ctx, tables, now)
}
