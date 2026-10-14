-- Shared sign-in across the VBCDX suite (issue 9). A Zitadel sign-in keeps
-- the provider's issuer, subject and session ID ("sid" in the ID token) on
-- the browser session, so a back-channel logout token naming that sid, or
-- that subject, finds the sessions to end.
ALTER TABLE sessions ADD COLUMN oidc_issuer TEXT;
ALTER TABLE sessions ADD COLUMN oidc_subject TEXT;
ALTER TABLE sessions ADD COLUMN oidc_sid TEXT;
CREATE INDEX sessions_oidc_sid ON sessions (oidc_issuer, oidc_sid);
CREATE INDEX sessions_oidc_subject ON sessions (oidc_issuer, oidc_subject);

-- Back-channel logout tokens already acted on, by issuer and "jti", kept
-- until the token expires so a replayed token is refused.
CREATE TABLE oidc_logout_tokens (
    issuer     TEXT NOT NULL,
    jti        TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (issuer, jti)
);

CREATE INDEX oidc_logout_tokens_expires_at ON oidc_logout_tokens (expires_at);
