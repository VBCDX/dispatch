package store

import "context"

// OpenAt opens rawURL and applies migrations up to version max only.
func OpenAt(ctx context.Context, rawURL string, max int) (*Store, error) {
	s, err := open(rawURL)
	if err != nil {
		return nil, err
	}
	if err := s.migrateTo(ctx, max); err != nil {
		s.db.Close()
		return nil, err
	}
	return s, nil
}
