-- SEC-A: append-only, hash-chained audit log for the leads-api Worker (SOC 2 retrofit).
--
-- One row per audited event: lead create, admin list, admin patch, and every request
-- refused for a missing or wrong secret. Rows hold IDs and outcome codes only: never lead
-- content, names, emails, phone numbers or any secret.
--
--   id          assigned by the Worker as (previous id + 1), so ids are gap-free and the
--               id is part of the hashed fields.
--   ts          ISO-8601 UTC text ending in Z (same shape as inbound_leads.created_at).
--   request_id  the X-Request-Id the Worker returned for the request.
--   actor       'shared-secret' (holder of LEADS_API_SECRET) or 'anonymous' (refused).
--   action      e.g. lead.create, lead.list, lead.update, auth.refused.
--   target      e.g. lead:42, leads:[1,2,3], or a route such as 'POST /leads'.
--   result      outcome code, e.g. accepted, rejected_validation, ok, refused_wrong_secret.
--   ip          CF-Connecting-IP of the caller (Netlify egress or the owner's machine).
--   user_agent  caller's User-Agent, truncated by the Worker.
--   prev_hash   row_hash of the previous row; 64 zeros for the first row.
--   row_hash    hex SHA-256 of prev_hash and the row's canonical fields (src/audit.ts).
--
-- prev_hash is UNIQUE, so two rows can never claim the same predecessor: concurrent
-- appends that read the same chain head conflict and the Worker retries with the new head.
CREATE TABLE IF NOT EXISTS audit_events (
  id          INTEGER PRIMARY KEY CHECK (id >= 1),
  ts          TEXT    NOT NULL
              CHECK (ts LIKE '____-__-__T__:__:__%Z' AND julianday(ts) IS NOT NULL),
  request_id  TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  target      TEXT,
  result      TEXT    NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  prev_hash   TEXT    NOT NULL UNIQUE CHECK (length(prev_hash) = 64),
  row_hash    TEXT    NOT NULL UNIQUE CHECK (length(row_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_audit_events_request_id ON audit_events (request_id);

-- Append-only, enforced by the database as well as by the Worker (which only INSERTs).
CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
