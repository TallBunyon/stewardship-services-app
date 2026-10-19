# leads-api: Cloudflare Worker + D1 for Services lead capture (SV-1)

Package **SV-1** of the Supabase → Cloudflare move for `services.stewardshipcomputellc.com`
(the homepage chat widget that captures leads).

**Status (2026-10-19):** built and tested on branch `backend/cloudflare`, including the SOC 2
security layer (package **SEC-SV**, [section 5](#5-security-layer-sec-sv)). Not merged, no pull
request, nothing deployed, no remote Cloudflare or Supabase resources touched.
**Merging this changes nothing live:** with `LEADS_BACKEND` unset, the Netlify functions
send the same Supabase requests as before (the tests check this).

| Package | Where | What | When |
|---|---|---|---|
| SV-1 | this branch | Worker, D1 schema, `LEADS_BACKEND` switch, tests, CI | done |
| SEC-SV | this branch | audit log, logging hygiene, CI security gates, `form-data` fix, token scope doc | done |
| SV-2 | owner's machine | create D1, deploy Worker, import 5 rows, turn on `dual` | ~2026-10-22 |
| switch | Netlify env | `LEADS_BACKEND=worker` after 7 days of dual write | ~2026-10-29 |
| last | Supabase | remove the Supabase project | after the switch |

> **Decision needed before dual write:** see [Open question 1](#open-questions). With the
> spec's strict validation, the Worker rejects every lead `chat.ts` writes today.

---

## 1. What was built

### Worker (`workers/leads-api/`)

Worker name `services-leads-api`. D1 binding `DB` → database `services-leads`.
It is called server to server only. It sends no CORS headers, so browsers cannot call it
cross-origin.

| Route | Auth | Result |
|---|---|---|
| `POST /leads` | `Authorization: Bearer <LEADS_API_SECRET>` | `201 {"id": n}` + `Location: /leads/n` |
| `GET /leads?downloaded=true\|false&limit=1..500&after_id=n` | same | `200 {"leads": [...], "next_after_id": n \| null}`, oldest id first, `downloaded` as boolean |
| `PATCH /leads/:id` body exactly `{"downloaded": true\|false}` | same | `200 {"lead": {...}}`, `404` unknown id |

Status codes: `400` validation or bad query (`{"error","details":[...]}`), `401` missing or
wrong secret (with `WWW-Authenticate: Bearer`), `405` wrong method (with `Allow`), `413` body
over 256 KiB, `415` body that is not JSON, `500` if `LEADS_API_SECRET` is unset (fails
closed: every route is refused) or if an admin read/write cannot be audited
(`audit_unavailable`), `503` paused. Every response carries an `X-Request-Id` header.

**Auth:** SHA-256 both values, then `crypto.subtle.timingSafeEqual`. This is a constant-time
check that hides both the content and the length of the secret (as the Cloudflare docs
recommend).

**POST validation** mirrors the live Supabase anon INSERT policy (read 2026-10-17):

- `name` not null and `<> ''`. As in Postgres, a whitespace-only name passes.
- `email` not null and matching `^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$`,
  case-insensitive (`~*`).
- `source` required (`NOT NULL` in the table).
- Length limits (UTF-16 characters): name 200, email 254, budget 500, timeline 500,
  transcript 100 000, source 100.
- Only `name, email, budget, timeline, transcript, source` are accepted. `id`,
  `created_at`, `downloaded` and any other key give `400`. The Worker sets `created_at`
  itself.

**Vars and secrets:**

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `LEADS_API_SECRET` | secret (`secrets.required`) | none | Bearer token for every route. `wrangler deploy` refuses to deploy until it is set. |
| `LEADS_WRITE_PAUSED` | var | `"false"` | `"true"` makes POST return `503` with `Retry-After: 300`. Auth is still checked first. GET and PATCH keep working. |
| `LEADS_ALLOW_TRANSCRIPT_ONLY` | var | `"false"` | `"true"` also accepts a lead with no name and no email but a non-empty transcript (the shape `chat.ts` writes). Any email given must still be valid, and a name without an email is still rejected. See open question 1. |

**D1 schema** (`migrations/0001_create_inbound_leads.sql`) mirrors the live table:

| Column | D1 | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Supabase ids import unchanged. New ids continue after the highest one and are never reused (like a Postgres identity). |
| `created_at` | `TEXT NOT NULL`, default `strftime('%Y-%m-%dT%H:%M:%fZ','now')` | ISO-8601 UTC ending in `Z`. A CHECK rejects Postgres-style text such as `2026-10-17 18:29:00+00` and impossible dates. |
| `name`, `email`, `budget`, `timeline`, `transcript` | `TEXT` | nullable |
| `source` | `TEXT NOT NULL` | |
| `downloaded` | `INTEGER NOT NULL DEFAULT 0`, CHECK `IN (0,1)` | |

There is also an index on `(downloaded, created_at)`. D1 limits LIKE/GLOB pattern
complexity, so the `created_at` CHECK uses a short `LIKE` plus `julianday()`. A longer GLOB
failed in local D1 and would fail remotely too.

### Netlify switch: `LEADS_BACKEND`

Shared logic: `netlify/lib/leads-backend.ts`. It sits outside `netlify/functions/` so
Netlify does not deploy it as a function; esbuild bundles it into each function that uses it.

| `LEADS_BACKEND` | `chat.ts` / `submit-lead.ts` |
|---|---|
| unset, `supabase`, or any unknown value (unknown values log a warning) | Supabase only, **exactly as before**: same request, same log lines, same error responses. |
| `dual` | Supabase first, exactly as before, and its result is what the user sees. Then POST to the Worker (5 s timeout). A Worker failure is logged as `Dual write: Worker save failed (user unaffected)` and never fails the user. The Worker write is attempted even when Supabase failed, so the lead is captured somewhere. |
| `worker` | Worker only. A Worker failure is treated the way a Supabase failure was: `chat.ts` logs it and carries on; `submit-lead.ts` returns 502 only if the notifications also fail, and its message then says "Worker". |

- New Netlify env names: `LEADS_BACKEND`, `LEADS_API_URL`, `LEADS_API_SECRET`. Placeholders
  are in `/.env.example`.
- `chat.ts` sends the Worker the same payload it sends Supabase: `{transcript, source}`.
- `submit-lead.ts` sends `{name, email, budget, timeline, transcript (or summary), source}`.

### `scripts/sync-leads.js`

`LEADS_BACKEND=worker` (from the environment or `./.env`) makes the script read unread leads
from `GET /leads?downloaded=false`, paginated, and mark each one with `PATCH /leads/:id`.
`supabase`, `dual` or unset read Supabase as before. The output still goes to `leads/`, which
is gitignored because it holds real customer data. The script's functions are now exported,
and `main()` runs only when the file is executed directly.

### CI: `.github/workflows/backend-ci.yml`

Runs on pushes to `backend/**`, which includes `backend/cloudflare` (also listed explicitly),
and on manual dispatch, with `contents: read` only:

- `worker-tests`: `npm audit --omit=dev --audit-level=high` (fails the job on any high or
  critical runtime advisory), Worker tests and typecheck.
- `netlify-tests`: function and script tests and typecheck.
- `root-app`: `npm audit --omit=dev --audit-level=high` for the site's runtime dependencies,
  then the site build (`tsc && vite build`).
- `gitleaks`: v8.30.1 installed with `go install` (checksum verified against
  sum.golang.org), scanning the full git history and the working tree.

### File map

```
.gitignore                         + .dev.vars, .env* (!.env.example), .wrangler/, dumps/, exports/, leads/, *.sql (!workers/*/migrations/*.sql)
.env.example                       + LEADS_BACKEND, LEADS_API_URL, LEADS_API_SECRET (placeholders)
.github/workflows/backend-ci.yml   CI
netlify/lib/leads-backend.ts       the switch
netlify/functions/chat.ts          uses the switch (Supabase code unchanged, function renamed)
netlify/functions/submit-lead.ts   uses the switch
scripts/sync-leads.js              Worker read path
tests/                             vitest for the functions and the script (separate package, see below)
workers/leads-api/
  wrangler.jsonc                   Worker config (database_id is a placeholder until SV-2)
  migrations/0001_*.sql            D1 schema
  migrations/0002_audit_events.sql append-only audit log (SEC-A)
  src/index.ts, src/validate.ts    Worker
  src/audit.ts                     audit append + verifyChain (SEC-A)
  src/log.ts                       structured JSON logs (SEC-K)
  test/leads.test.ts               SV-1 behaviour tests
  test/audit.test.ts               SEC-SV tests (audit rows, chain, no-leak scan)
  .dev.vars.example                secret names for `wrangler dev`
```

`tests/` is its own npm package on purpose. Adding vitest to the root `package.json` bumped
`postcss`, `nanoid`, `source-map-js` and `tinyglobby` in the root lockfile, which the live
site build uses. The root `package.json` is untouched. The root `package-lock.json` changed
only in SEC-SV, for the `form-data` runtime advisory (two entries, see section 5).
`npm run build` at the root still passes, and both functions still bundle with esbuild.

---

## 2. Tests

Toolchain, all pinned exactly:

- Worker: `wrangler 4.147.0`, `@cloudflare/vitest-plugin 1.3.6`, `vitest 4.1.11`,
  `typescript 5.9.3`. The brief named `@cloudflare/vitest-pool-workers`; that package is
  deprecated ("renamed to @cloudflare/vitest-plugin"), and the plugin is its successor with
  the same API. Tests run inside workerd against a local D1 with the real migration applied.
- `tests/`: `vitest 4.1.11`, `@netlify/functions 2.8.2`, `@types/node 22.20.4`,
  `typescript 5.9.3`. `fetch` is mocked.

```sh
# Worker (from the repo root)
cd workers/leads-api
npm ci
npm run types        # wrangler types --strict-vars=false -> worker-configuration.d.ts (gitignored, offline)
npm run typecheck
npm test

# Netlify functions + sync script
cd tests
npm ci
npm run typecheck
npm test
```

Results on `backend/cloudflare` with SEC-SV on 2026-10-19 (Node 22.22.0, npm 10.9.4). Both
typechecks were clean:

```
workers/leads-api  $ npm test
 RUN  v4.1.11 .../workers/leads-api
 Test Files  2 passed (2)
      Tests  119 passed (119)      # leads.test.ts 85 (SV-1) + audit.test.ts 34 (SEC-SV)

tests  $ npm test
 RUN  v4.1.11 .../tests
 Test Files  4 passed (4)
      Tests  47 passed (47)
```

What they cover:

- **Worker (85):**
  - a valid insert gives 201 with the id and stores the row;
  - empty, missing or null name and email give 400;
  - 11 bad emails give 400, and 3 valid emails the live regex accepts give 201;
  - the whitespace-name parity case;
  - unknown and protected fields; every length limit, over and exactly at the limit;
  - 413, 415 and invalid JSON;
  - missing, wrong, prefix-only and non-Bearer secrets give 401;
  - an unset server secret gives 500;
  - paused gives 503 with Retry-After, auth is still checked first, and GET/PATCH keep
    working;
  - the transcript-only flag, both off and on;
  - admin GET auth, filter and pagination;
  - admin PATCH auth, true/false, 404, bad id and bad body;
  - 404/405 routing;
  - the `wrangler.jsonc` defaults through `exports.default.fetch`;
  - migration behaviour for the import: imported ids are kept and the next id continues
    after them, and the defaults and CHECK constraints work.
- **Worker, SEC-SV (34, `test/audit.test.ts`):**
  - each event type writes exactly one audit row with the right action, result, actor and
    target (lead create accepted, validation-rejected, bad body, paused; admin list ok and
    bad query; admin patch ok, 404 and bad id; unsupported method (a method outside the
    known list is recorded as `OTHER`); missing, wrong and
    non-Bearer secret on all three routes, each with 401; unset server secret);
  - an unknown path writes no row; the user agent is truncated;
  - 12 concurrent requests each get one row and the chain stays linear;
  - audit outage: lead create still returns 201 (fail open), admin list and patch return 500
    with no data (fail closed);
  - `verifyChain` passes on an empty and on a clean log (also across page boundaries), and
    fails on an altered row, on a forged row with a recomputed hash, and on a deleted row;
    the database refuses `UPDATE` and `DELETE` on `audit_events`;
  - a scan of every audit row and every captured log line finds neither the secret
    (generated at test time) nor the lead's email, phone or name, and every request log line
    has `request_id`, `route`, `status` and `duration_ms`.
  - These tests were mutation-checked: logging the `Authorization` header, putting the email
    in the audit target, skipping the hash check in `verifyChain`, and disabling the chain
    retry each made them fail.
- **tests/ (47):**
  - for each of `chat.ts` and `submit-lead.ts`: all three modes;
  - the Supabase request (URL, method, headers, JSON body) is unchanged in `supabase` and
    `dual` mode;
  - in dual mode, a Worker 4xx, a network error or missing Worker config still gives the
    user 200;
  - in dual mode, a Supabase failure still writes the Worker;
  - in worker mode, Supabase is never called;
  - `sync-leads` against the Worker (pagination, PATCH) and against Supabase.

Notes:

- The Worker test run prints `Missing required secrets: LEADS_API_SECRET`. This is
  expected: the tests inject a placeholder secret as a Miniflare binding
  (`vitest.config.ts`), not through `.dev.vars`.
- npm 10.9.x fails a *fresh* resolve of these trees with `Cannot read properties of null
  (reading 'edgesOut')`, an npm arborist bug. `npm ci` from the committed lockfiles works on
  npm 10. To change dependencies, use `npx npm@11.6.2 install ...`.

---

## 3. SV-2 deploy steps (local, on the owner's machine)

Nothing below has been run. Run commands from `workers/leads-api/` unless noted. They work
in bash and PowerShell. Secrets go into the terminal prompt, a password manager, or a file
outside the repo, never into a tracked file.

**Order matters:** import before dual write, so that D1's ids continue after the imported
ones.

0. **Prerequisites.**
   ```sh
   npm ci
   npx wrangler login
   ```
   Optional local dry run:
   ```sh
   cp .dev.vars.example .dev.vars        # then put any test value after LEADS_API_SECRET=
   npx wrangler d1 migrations apply services-leads --local
   npx wrangler dev                      # then curl http://localhost:8787/leads -H "Authorization: Bearer <value>"
   ```
1. **Create the database.**
   ```sh
   npx wrangler d1 create services-leads          # optional: --location=enam
   ```
   If wrangler offers to add the binding for you, answer **No**: the `DB` binding already
   exists. Put the printed `database_id` into `wrangler.jsonc`, replacing
   `00000000-0000-0000-0000-000000000000`. A D1 id is not a credential, so it may be
   committed.
2. **Apply the schema.**
   ```sh
   npx wrangler d1 migrations apply services-leads --remote
   npx wrangler d1 execute services-leads --remote --command "SELECT type, name FROM sqlite_master WHERE type IN ('table','index','trigger')"
   ```
3. **Export the existing Supabase rows (5 as of 2026-10-17)** as D1-ready SQL. Run this
   read-only SELECT in the Supabase SQL editor and save the single output value as
   `workers/leads-api/exports/import-inbound-leads.sql`. Both `exports/` and `*.sql` are
   gitignored; it contains customer data. The query doubles single quotes by hand instead of
   using `quote_literal`/`%L`, because those emit Postgres `E'...'` strings, which SQLite
   cannot read, whenever a value contains a backslash (JSON transcripts do).
   ```sql
   select string_agg(format(
     'INSERT INTO inbound_leads (id, created_at, name, email, budget, timeline, transcript, source, downloaded) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s);',
     id,
     '''' || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '''',
     coalesce('''' || replace(name,       '''', '''''') || '''', 'NULL'),
     coalesce('''' || replace(email,      '''', '''''') || '''', 'NULL'),
     coalesce('''' || replace(budget,     '''', '''''') || '''', 'NULL'),
     coalesce('''' || replace(timeline,   '''', '''''') || '''', 'NULL'),
     coalesce('''' || replace(transcript, '''', '''''') || '''', 'NULL'),
     '''' || replace(source, '''', '''''') || '''',
     case when downloaded then 1 else 0 end
   ), E'\n' order by id)
   from public.inbound_leads;
   ```
4. **Import the rows and verify.**
   ```sh
   npx wrangler d1 execute services-leads --remote --file=exports/import-inbound-leads.sql
   npx wrangler d1 execute services-leads --remote --command "SELECT COUNT(*) AS n, MAX(id) AS max_id, SUM(downloaded) AS downloaded FROM inbound_leads"
   ```
   Compare with Supabase:
   `select count(*), max(id), count(*) filter (where downloaded) from public.inbound_leads;`
   Then delete the export file.
5. **Generate the shared secret and deploy.** `secrets.required` makes `wrangler deploy`
   refuse to deploy without the secret, so the first deploy uploads it with
   `--secrets-file`. The file goes outside the repo:
   ```sh
   node -e "require('fs').writeFileSync(require('os').homedir()+'/leads-api.secrets.env','LEADS_API_SECRET='+require('crypto').randomBytes(32).toString('hex')+'\n')"
   npx wrangler deploy --secrets-file "$HOME/leads-api.secrets.env"
   ```
   - Copy the value into the password manager.
   - Note the URL: `https://services-leads-api.<subdomain>.workers.dev`.
   - Delete the secrets file.
   - Rotate later with `npx wrangler secret put LEADS_API_SECRET`.
   - The only Worker secret is **`LEADS_API_SECRET`**.
6. **Smoke test.**
   - `curl https://services-leads-api.<subdomain>.workers.dev/leads` should give `401`.
   - The same URL with `-H "Authorization: Bearer <secret>"` should give `200` and the
     imported rows.
   - Do not POST test leads to the live database. If you have to, delete them afterwards
     with `wrangler d1 execute`.
7. **Decide open question 1.** If transcript-only leads are approved:
   - set `"LEADS_ALLOW_TRANSCRIPT_ONLY": "true"` in `wrangler.jsonc`;
   - run `npx wrangler deploy`;
   - commit the change.

   Without this, every chat lead gets `400` from the Worker in dual mode, and you will see
   `Dual write: Worker save failed ... 400` for each one.
8. **Merge to main on the owner's go.** Netlify builds only `main`. With `LEADS_BACKEND`
   unset the deploy behaves exactly as today.
9. **Netlify env** (Site configuration → Environment variables, scope Functions):

   | Name | Value |
   |---|---|
   | `LEADS_API_URL` | `https://services-leads-api.<subdomain>.workers.dev` |
   | `LEADS_API_SECRET` | the same value as the Worker secret |
   | `LEADS_BACKEND` | `dual` |

   Then **trigger a redeploy**: function env changes take effect on the next deploy.
   Keep `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` until Supabase is removed.
10. **Check right after dual-on.** Confirm Supabase's count has not moved since the export
    in step 3. If a lead arrived in between, insert it into D1 without its id; Supabase and
    D1 ids then differ for that row (see open question 5).
11. **During the 7 days.**
    - Check the Netlify function logs for `Dual write: Worker save failed`.
    - Watch the Worker logs: `npx wrangler tail`, or the dashboard (observability is on).
    - Compare counts daily: Supabase `count(*)` against
      `npx wrangler d1 execute services-leads --remote --command "SELECT COUNT(*) FROM inbound_leads"`.
    - Audit log at a glance:
      `npx wrangler d1 execute services-leads --remote --command "SELECT action, result, COUNT(*) AS n FROM audit_events GROUP BY action, result"`.
      A burst of `auth.refused` rows means something is probing the Worker or a caller has a
      stale secret.

**Local `.env` for `sync-leads`:** during dual, keep reading Supabase (leave `LEADS_BACKEND`
unset or `dual`). At the switch, add `LEADS_BACKEND=worker`, `LEADS_API_URL` and
`LEADS_API_SECRET`.

## 4. Operating it

- **Rollback (any time):** in Netlify, set `LEADS_BACKEND=supabase` or delete it, then
  redeploy. Supabase was written all along in `dual`, so nothing is lost.
- **Pause Worker writes:** set `LEADS_WRITE_PAUSED` to `"true"` and run
  `npx wrangler deploy`.
  - In `dual`, leads still reach Supabase.
  - In `worker` mode a pause means leads are **not stored**: `chat.ts` logs and carries on,
    and `submit-lead.ts` falls back to notifications only. Use it only briefly.
- **Rotate the secret:** run `npx wrangler secret put LEADS_API_SECRET`, update
  `LEADS_API_SECRET` in Netlify, and redeploy Netlify. Do it in `dual`, where the gap only
  produces logged Worker failures.
- **Switch (~10-29), after 7 clean days:**
  1. Run `sync-leads` once more in Supabase mode.
  2. Mark those rows in D1:
     `UPDATE inbound_leads SET downloaded = 1 WHERE created_at < '<time of that sync, ISO Z>'`.
     This stops the first worker-mode sync from downloading them again.
  3. Set `LEADS_BACKEND=worker` in Netlify and in the local `.env`, then redeploy.
- **Remove Supabase last,** once `worker` has run cleanly. Delete
  `netlify/supabase/create_inbound_leads.sql` and the Supabase code paths then.

---

## 5. Security layer (SEC-SV)

Retrofit of the SOC 2-ready practice approved 2026-10-17: audit log, logging hygiene and CI
security gates before the backend goes live. Built 2026-10-19 on `backend/cloudflare`.
Nothing here changes what the Netlify functions send or what the site does; the dual-write
switch still defaults to `supabase`.

### SEC-A: audit log (`audit_events`)

`migrations/0002_audit_events.sql` adds an append-only table:
`id, ts, request_id, actor, action, target, result, ip, user_agent, prev_hash, row_hash`.

- **Append-only twice over.** The Worker only ever `INSERT`s into it (no route updates or
  deletes audit rows), and two triggers make the database itself abort any `UPDATE` or
  `DELETE` on the table.
- **Hash chain.** `row_hash` = hex SHA-256 of `prev_hash`, a newline, and the JSON array
  `[id, ts, request_id, actor, action, target, result, ip, user_agent]`. The first row's
  `prev_hash` is 64 zeros. The Worker assigns `id` = previous id + 1, so ids are gap-free.
- **Concurrency.** `prev_hash` and `id` are both unique. Two requests that read the same
  chain head cannot both insert; the loser re-reads the head and retries (up to 8 tries,
  jittered). The tests fire 12 concurrent requests and check the chain is still linear.
- **`verifyChain(db)`** (`src/audit.ts`) walks the table in id order and reports
  `{ok: true, rows, head_id, head_hash}` or `{ok: false, broken_at_id, reason}` for a
  changed row, a forged row with a recomputed hash (caught at the next row), or a deleted
  row (id gap).
- **Rows hold IDs and codes only:** never lead content, names, emails, phone numbers, raw
  paths or any secret. `target` for a refused request is the route template
  (`PATCH /leads/:id`), never the raw path, because the path is caller-controlled.
- `ip` is `CF-Connecting-IP` of the **caller** (Netlify's egress, or the owner's machine for
  `sync-leads`), not of the person who wrote the lead. `user_agent` is cut to 256 characters.

One row per event:

| Event | `action` | `result` | `actor` | `target` |
|---|---|---|---|---|
| `POST /leads` stored | `lead.create` | `accepted` | `shared-secret` | `lead:<id>` |
| `POST /leads` failed validation | `lead.create` | `rejected_validation` | `shared-secret` | null |
| `POST /leads` body too large, not JSON or invalid JSON | `lead.create` | `rejected_body` | `shared-secret` | null |
| `POST /leads` while `LEADS_WRITE_PAUSED` | `lead.create` | `rejected_paused` | `shared-secret` | null |
| `GET /leads` (admin list; there is no single-lead read route) | `lead.list` | `ok` or `rejected_validation` | `shared-secret` | `leads:[<ids returned>]` |
| `PATCH /leads/:id` | `lead.update` | `ok`, `not_found`, `rejected_validation` or `rejected_body` | `shared-secret` | `lead:<id>` (null for a non-numeric id) |
| authenticated request with an unsupported method | `request.unsupported` | `rejected_method` | `shared-secret` | e.g. `DELETE /leads` |
| missing secret (no header, not `Bearer`, or empty) | `auth.refused` | `refused_missing_secret` | `anonymous` | route template |
| wrong secret (constant-time compare) | `auth.refused` | `refused_wrong_secret` | `anonymous` | route template |
| `LEADS_API_SECRET` unset on the Worker | `auth.refused` | `refused_server_misconfigured` | `anonymous` | route template |
| a handler throws after auth | that route's action | `error` | `shared-secret` | as far as known |

Unknown paths (404 before auth) are logged, not audited. **Rate-limit trips:** none, because
the Worker has no rate limiter (open question 7).

**If the audit row cannot be written:**

- `lead.create` **fails open**: the lead is stored and the caller gets `201`. An
  `audit_write_failed` error is logged. A customer's lead is never lost because of auditing.
- `lead.list` and `lead.update` **fail closed**: `500 {"error":"audit_unavailable"}` and no
  lead data. An admin read that cannot be audited does not happen. For `PATCH`, the flag is
  already set by then; a retry is harmless (same value) and gets its own row.

**What the chain does not cover:**

- Anyone with D1 write access (a token with D1 Edit, or the dashboard) can drop the triggers
  and rewrite the whole chain consistently, or cut rows off the end. The anchor outside D1
  is the log stream: every request log line carries `audit_id` and `audit_hash`. With
  Logpush to R2 (account level, set up by the COO, not in this repo), compare the last logged
  `audit_hash` with the head that `verifyChain` reports.
- Changes made outside the Worker (`wrangler d1 execute`, such as the SV-2 import or the
  switch-day `UPDATE`) never pass through the Worker, so they are not in `audit_events`.
  Cloudflare's account audit log records those API calls.
- `verifyChain` runs in the tests. A route or script that runs it against the remote
  database is not built yet (follow-up).

### SEC-K: logging hygiene

- One JSON line per request (`src/log.ts`), which Workers Logs indexes field by field:
  `{"level":"info","event":"request","request_id","route","status","duration_ms","audit_id","audit_hash"}`.
- Other events: `audit_write_failed`, `unhandled_error`, `server_misconfigured` (level
  `error`), each with `request_id` and `route`.
- `route` is a template (`PATCH /leads/:id`, `GET (unmatched)`). Logs never hold raw paths,
  query strings, headers, request or response bodies, lead fields, or secrets. The tests
  capture every console line and scan it, and every audit row, for the secret, the lead's
  email, phone and name.
- `request_id` is a random UUID per request, also returned as `X-Request-Id`.
- `"observability": { "enabled": true }` is set in `wrangler.jsonc` (it was already on).
  Logpush to R2 is account-level and done separately by the COO.
- **Finding, not changed here:** the Netlify functions log upstream error bodies
  (`Supabase lead save failed: <status> <body>`). For a Postgres constraint violation,
  Supabase's body can include `Failing row contains (...)` with the lead's values. Those log
  lines must stay byte-identical in `supabase` mode until the switch, so trimming them is a
  follow-up for after the switch.

### SEC-J: CI gates

See [CI](#ci-githubworkflowsbackend-ciyml): `gitleaks` (history and working tree),
`npm audit --omit=dev --audit-level=high` for the Worker and for the root app's runtime
dependencies (the job fails on any high or critical advisory), and the root site build.

### Dependency advisories

**Fixed: `form-data` (high, runtime, root `package-lock.json`).** GHSA-hmw2-7cc7-3qxx, CRLF
injection, affects 4.0.0 to 4.0.5. Path: `@anthropic-ai/sdk 0.39.0` → `@types/node-fetch
2.6.13` → `form-data ^4.0.4`. `npm update form-data` moved it **4.0.5 → 4.0.6** inside the
existing range, and its dependency `hasown` 2.0.2 → 2.0.4. No other lockfile entry changed,
`package.json` is untouched, and no `--force` was used. After the fix,
`npm audit --omit=dev` reports `found 0 vulnerabilities` for the root and for the Worker.

**Still open, dev-only (build and test tooling, not in the deployed functions or the
browser bundle).** Not fixed here: the root ones change the live site's build toolchain,
and the Worker ones change the pinned test toolchain three days before D-day.

| Where | Package (installed) | Advisory range | Fix it needs |
|---|---|---|---|
| root | `vite` 5.4.21 | ≤ 6.4.2 | **major**: vite 6.4.3+ (npm audit proposes 8.3.4), with a matching `@vitejs/plugin-react` |
| root | `postcss` 8.5.8 | ≤ 8.5.22 | 8.5.23+, in range: `npm audit fix` (no `--force`) |
| root | `nanoid` 3.3.11 (via postcss) | ≤ 3.3.17 | 3.3.18+ (latest 3.x is 3.3.20), in range: `npm audit fix` |
| root | `browserslist` 4.28.2 | ≤ 4.28.6 | 4.28.7+, in range: `npm audit fix` |
| root | `source-map-js` 1.2.1 | 1.0.0 to 1.2.1 | 1.2.2, in range: `npm audit fix` |
| root | `braces` 3.0.3 (via `tailwindcss` 3 → `chokidar`, `micromatch`; also flags `fast-glob`, `micromatch`, `chokidar`, `tailwindcss`) | all versions | no fixed `braces`; only **major** `tailwindcss` 4 drops the chain |
| Worker | `sharp` (via `miniflare`, used by `wrangler` and `@cloudflare/vitest-plugin`) | < 0.35.5 | bump the exact pins: `wrangler` 4.147.0 → 4.149+ (npm proposes 4.151.2) and `@cloudflare/vitest-plugin` 1.3.6 → 1.3.8+ (proposes 1.4.5); re-check `compatibility_date` |

The in-range root fixes are one `npm audit fix` without `--force`, then `npm run build` and a
look at the site. That is best done as its own change after D-day.

### SEC-H: Cloudflare API token for this Worker

For automation, or for any deploy that is not the owner's interactive `wrangler login`.
Names only; values never go into the repo. Create **account-owned** tokens (Manage Account →
Account API Tokens): Wrangler only honours granular permissions with account-owned tokens.
Give Wrangler `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment, so it
does not need to list accounts.

**Token 1, `services-leads-api deploy`:**

| Setting | Value |
|---|---|
| Workers | scope **Specified Workers** → `services-leads-api`, role **Editor** |
| Everything else | none: no zone, DNS, routes, account settings, user, R2, KV or Logpush permissions |
| TTL | start today, **end date at most 90 days out** (tokens never expire unless you set an end date) |
| Client IP address filtering | **Is in** the deploying machine or CI egress range, if it is stable |

Editor on that one Worker covers `wrangler deploy` of the **existing** Worker and its
settings (vars, `observability`). The docs describe Editor as "update content and
settings", which should include `wrangler secret put LEADS_API_SECRET`; that mapping was not
confirmed, so check it on first use. Editor cannot create or delete Workers: that needs
Admin at the Workers product scope. SV-2's first deploy creates
the Worker, so it stays on the owner's `wrangler login`. Fallback if the per-Worker scope
returns `403 code 10000` (reported by some users in 2026-09/10): account permission
**Workers Scripts: Edit**. That is broader, because it covers every Worker in the account.

**Token 2, `services-leads D1 migrations`, created only when a migration or `d1 execute`
is due:**

| Setting | Value |
|---|---|
| Account permission | **D1: Edit** (use **D1: Read** for read-only checks such as counting rows) |
| TTL | **end date the same or next day**; delete it after the run |
| Client IP address filtering | the owner's machine |

As of 2026-10-19, API tokens have no per-database D1 scope (Cloudflare's blog lists D1
resource scopes as coming next), so D1 Edit reaches every D1 database in the account. That is why it is a separate,
short-lived token. Neither token needs **Workers Tail** (use the dashboard's Workers Logs).

Source: Cloudflare's docs on Workers roles and permissions, on restricting tokens (TTL and
IP filtering), and the 2026-09-15 changelog on per-Worker permissions. They were read via
search summaries on 2026-10-19, because `developers.cloudflare.com` was blocked from the
build session. Check the exact labels in the dashboard when creating the tokens.

---

## Open questions

1. **Transcript-only chat leads vs. strict validation (blocks a useful dual write).**
   - The brief asks the Worker to validate exactly like the live anon policy (name and
     email required).
   - But `chat.ts`, the only write path the site's frontend calls, inserts only
     `{transcript, source}` with the **service role**, which bypasses that policy.
   - The chat prompt never asks for a name, so every chat lead has name and email null.
   - Under the strict rule, the Worker rejects 100% of chat leads: the dual-write week would
     prove nothing, and after the switch chat leads would not be stored.
   - Built: `LEADS_ALLOW_TRANSCRIPT_ONLY`, off by default (spec behaviour) and tested both
     ways.
   - **Recommendation:** set it to `"true"` before dual write. It mirrors what the live
     system actually accepts from the app today, still validates any email that is given,
     and still sits behind the bearer secret.
   - The alternative is a product change: make the chat collect name and email, and have
     `chat.ts` send them.
2. **Regex character.** The brief rendered the policy regex with a full-width `＠` (U+FF20).
   I took it as a formatting artifact and implemented ASCII `@`, which the brief also used
   in the package name. Confirm against the live policy:
   `select policyname, cmd, with_check from pg_policies where tablename = 'inbound_leads';`
3. **`submit-lead.ts` has no caller in the frontend:** `src/hooks/useChat.ts` only calls
   `/.netlify/functions/chat`. Is it called by something external, or is it dead code? It
   is switched and tested either way.
4. **Validation divergence in dual mode.** `submit-lead.ts` does not check the email
   format, and the service role bypasses the policy. A malformed email or an over-long
   field is therefore stored by Supabase, but the Worker rejects it with 400. In dual mode
   this is only logged. Acceptable, or should `submit-lead.ts` validate up front?
5. **Ids and `downloaded` flags after the switch.**
   - Ids match for imported rows.
   - Rows written during dual get independent ids in Supabase and D1. They usually line up
     if the import and dual-on happen back to back with no lead in between, but this is not
     guaranteed.
   - `created_at` for the same lead differs by the request latency, because each store sets
     its own.
   - Match rows on `(source, created_at within a few seconds, transcript)` if you need to
     reconcile.
   - `downloaded` flags set by Supabase-mode syncs during dual are not mirrored to D1; the
     switch step above handles this.
   - Should dual mode instead fetch the Supabase id (`Prefer: return=representation`) and
     send it to the Worker? That changes the Supabase request, which the brief said to keep
     exactly as today.
6. **"Staging".** The brief says SV-2 "deploys to staging". This config has one Worker and
   one D1 database (`services-leads`), and dual write and the import put real data there.
   If you want a separate throwaway staging Worker and DB, add `env.staging` to
   `wrangler.jsonc`.
7. **Hardening follow-ups, deliberately not done in SV-1:**
   - Pin the GitHub Actions to commit SHAs. The SHAs could not be resolved from this
     session.
   - The Worker has no rate limiting. It relies on the bearer secret, since it is server to
     server only. Since SEC-SV every refused request also writes an audit row, so a flood of
     unauthenticated requests now costs D1 writes as well; a Workers rate-limit binding in
     front of auth (with its own `rate_limit.trip` audit row) is the fix. See section 5.
8. **Pre-existing on `main`, not changed here:**
   - `chat.ts` and `submit-lead.ts` hard-code the owner's address as the `NOTIFY_EMAIL`
     fallback in this public repo. Removing it changes live behaviour if `NOTIFY_EMAIL` is
     unset, so it is left for a separate change.
   - `dist/` is tracked in git even though `.gitignore` lists it. Netlify rebuilds on deploy
     anyway, but a local `npm run build` dirties the tree.
