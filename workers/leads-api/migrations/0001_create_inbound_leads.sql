-- Mirrors Supabase public.inbound_leads as read from the live database on 2026-10-17:
--   id bigint identity PK, created_at timestamptz not null default now(),
--   name/email/budget/timeline/transcript text null, source text not null,
--   downloaded boolean not null default false.
--
-- D1 (SQLite) mapping:
--   id          INTEGER PRIMARY KEY (rowid alias) so the existing Supabase ids can be
--               imported unchanged; new rows continue after the highest id present.
--               AUTOINCREMENT means an id is never reused, like a Postgres identity.
--   created_at  ISO-8601 UTC text ending in Z, e.g. 2026-10-17T18:29:00.123Z.
--               The CHECK rejects Postgres-style text ('2026-10-17 18:29:00+00') so the
--               import must convert timestamps. (D1 limits LIKE/GLOB pattern complexity,
--               hence a short LIKE shape check plus julianday() for a real date.)
--   downloaded  0 or 1.
CREATE TABLE IF NOT EXISTS inbound_leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
              CHECK (created_at LIKE '____-__-__T__:__:__%Z' AND julianday(created_at) IS NOT NULL),
  name        TEXT,
  email       TEXT,
  budget      TEXT,
  timeline    TEXT,
  transcript  TEXT,
  source      TEXT    NOT NULL,
  downloaded  INTEGER NOT NULL DEFAULT 0 CHECK (downloaded IN (0, 1))
);

-- sync-leads reads "not downloaded, oldest first".
CREATE INDEX IF NOT EXISTS idx_inbound_leads_downloaded_created_at
  ON inbound_leads (downloaded, created_at);
