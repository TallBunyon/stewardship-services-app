import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeRowHash, GENESIS_HASH, USER_AGENT_MAX_LENGTH, verifyChain, type AuditRow } from '../src/audit'
import worker from '../src/index'

// SEC-A / SEC-K tests. Storage is per test file and audit_events is append-only (the
// migration's triggers block UPDATE and DELETE), so rows accumulate across the tests in this
// file. Each test finds its own rows by the X-Request-Id the Worker returns, and counts rows
// before and after a request to prove it wrote exactly one.

const SECRET = env.LEADS_API_SECRET // dummy generated per run in vitest.config.ts
const BASE = 'https://leads-api.test'
// RFC 5737 documentation address (TEST-NET-1); never routable.
const CALLER_IP = '192.0.2.10'
const CALLER_UA = 'leads-api-audit-test/1.0'

type EnvOverrides = Partial<Record<keyof Env, unknown>>

async function call(request: Request, overrides: EnvOverrides = {}): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    request as Request<unknown, IncomingRequestCfProperties>,
    { ...env, ...overrides } as Env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  return response
}

function request(
  method: string,
  path: string,
  options: { secret?: string | null; body?: unknown; headers?: Record<string, string> } = {}
): Request {
  const secret = options.secret === undefined ? SECRET : options.secret
  const headers: Record<string, string> = {
    'CF-Connecting-IP': CALLER_IP,
    'User-Agent': CALLER_UA,
    ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }),
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...options.headers,
  }
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
  return new Request(`${BASE}${path}`, { method, headers, body })
}

// Placeholder data only (example.com is reserved for documentation, 555-01xx for fiction).
const LEAD = {
  name: 'Audit Test Person',
  email: 'audit.test.person@example.com',
  budget: '$1k-$5k',
  timeline: '1-2 months',
  transcript: '[{"role":"user","content":"call me on 555-0142"}]',
  source: 'steward-services',
}

async function auditCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_events').first<{ n: number }>()
  return row?.n ?? 0
}

async function auditRowsFor(requestId: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM audit_events WHERE request_id = ?')
    .bind(requestId)
    .all<AuditRow>()
  return results
}

async function createLeadId(): Promise<number> {
  const response = await call(request('POST', '/leads', { body: LEAD }))
  expect(response.status).toBe(201)
  return (await response.json<{ id: number }>()).id
}

// Sends the request and checks that it wrote exactly one audit row, then returns that row.
async function callAndGetAuditRow(
  req: Request,
  overrides: EnvOverrides = {}
): Promise<{ response: Response; row: AuditRow }> {
  const before = await auditCount()
  const response = await call(req, overrides)
  const requestId = response.headers.get('X-Request-Id')
  expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

  const rows = await auditRowsFor(requestId!)
  expect(rows).toHaveLength(1)
  expect(await auditCount()).toBe(before + 1)
  return { response, row: rows[0] }
}

// Recreates the append-only triggers after a test has dropped one to simulate tampering
// by someone with direct database access.
async function restoreTriggers(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
       BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END`
    ),
    env.DB.prepare(
      `CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
       BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END`
    ),
  ])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verifyChain on an empty log', () => {
  // Runs first in this file, before any request has written a row.
  it('passes with zero rows and the genesis hash as head', async () => {
    expect(await verifyChain(env.DB)).toEqual({ ok: true, rows: 0, head_id: null, head_hash: GENESIS_HASH })
  })
})

describe('one audit row per event', () => {
  it('lead create accepted -> lead.create / accepted, target lead:<id>', async () => {
    const { response, row } = await callAndGetAuditRow(request('POST', '/leads', { body: LEAD }))
    expect(response.status).toBe(201)
    const { id } = await response.json<{ id: number }>()
    expect(row).toMatchObject({
      actor: 'shared-secret',
      action: 'lead.create',
      result: 'accepted',
      target: `lead:${id}`,
      ip: CALLER_IP,
      user_agent: CALLER_UA,
    })
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(row.prev_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.row_hash).toBe(await computeRowHash(row))
  })

  it('lead create validation-rejected -> lead.create / rejected_validation, no target', async () => {
    const { response, row } = await callAndGetAuditRow(
      request('POST', '/leads', { body: { ...LEAD, email: 'not-an-email' } })
    )
    expect(response.status).toBe(400)
    expect(row).toMatchObject({ actor: 'shared-secret', action: 'lead.create', result: 'rejected_validation', target: null })
  })

  it('lead create with an unreadable body -> lead.create / rejected_body', async () => {
    const { response, row } = await callAndGetAuditRow(request('POST', '/leads', { body: '{"name": ' }))
    expect(response.status).toBe(400)
    expect(row).toMatchObject({ action: 'lead.create', result: 'rejected_body', target: null })
  })

  it('lead create while paused -> lead.create / rejected_paused', async () => {
    const { response, row } = await callAndGetAuditRow(request('POST', '/leads', { body: LEAD }), {
      LEADS_WRITE_PAUSED: 'true',
    })
    expect(response.status).toBe(503)
    expect(row).toMatchObject({ action: 'lead.create', result: 'rejected_paused' })
  })

  it('admin list -> lead.list / ok, target lists the returned ids', async () => {
    const id = await createLeadId()
    const { response, row } = await callAndGetAuditRow(request('GET', `/leads?after_id=${id - 1}`))
    expect(response.status).toBe(200)
    const { leads } = await response.json<{ leads: Array<{ id: number }> }>()
    expect(leads.map((lead) => lead.id)).toEqual([id])
    expect(row).toMatchObject({ actor: 'shared-secret', action: 'lead.list', result: 'ok', target: `leads:[${id}]` })
  })

  it('admin list with a bad query -> lead.list / rejected_validation', async () => {
    const { response, row } = await callAndGetAuditRow(request('GET', '/leads?limit=0'))
    expect(response.status).toBe(400)
    expect(row).toMatchObject({ action: 'lead.list', result: 'rejected_validation', target: null })
  })

  it('admin patch -> lead.update / ok, target lead:<id>', async () => {
    const id = await createLeadId()
    const { response, row } = await callAndGetAuditRow(
      request('PATCH', `/leads/${id}`, { body: { downloaded: true } })
    )
    expect(response.status).toBe(200)
    expect(row).toMatchObject({ actor: 'shared-secret', action: 'lead.update', result: 'ok', target: `lead:${id}` })
  })

  it('admin patch of an unknown id -> lead.update / not_found', async () => {
    const { response, row } = await callAndGetAuditRow(
      request('PATCH', '/leads/999999', { body: { downloaded: true } })
    )
    expect(response.status).toBe(404)
    expect(row).toMatchObject({ action: 'lead.update', result: 'not_found', target: 'lead:999999' })
  })

  it('admin patch with a bad id -> lead.update / rejected_validation, no target', async () => {
    const { response, row } = await callAndGetAuditRow(
      request('PATCH', '/leads/abc', { body: { downloaded: true } })
    )
    expect(response.status).toBe(400)
    expect(row).toMatchObject({ action: 'lead.update', result: 'rejected_validation', target: null })
  })

  it('authenticated request with an unsupported method -> request.unsupported / rejected_method', async () => {
    const { response, row } = await callAndGetAuditRow(request('DELETE', '/leads'))
    expect(response.status).toBe(405)
    expect(row).toMatchObject({ action: 'request.unsupported', result: 'rejected_method', target: 'DELETE /leads' })
  })

  // workerd refuses non-standard method strings outright; TRACE is valid but not routed.
  it('a method outside the known list is recorded as OTHER, never verbatim', async () => {
    const { response, row } = await callAndGetAuditRow(request('TRACE', '/leads'))
    expect(response.status).toBe(405)
    expect(row).toMatchObject({ action: 'request.unsupported', target: 'OTHER /leads' })
  })

  describe('requests refused for their secret get 401 and one auth.refused row', () => {
    const routes: Array<[string, string, unknown]> = [
      ['POST', '/leads', LEAD],
      ['GET', '/leads', undefined],
      ['PATCH', '/leads/1', { downloaded: true }],
    ]

    it.each(routes)('missing secret on %s %s -> refused_missing_secret', async (method, path, body) => {
      const { response, row } = await callAndGetAuditRow(request(method, path, { secret: null, body }))
      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
      expect(row).toMatchObject({
        actor: 'anonymous',
        action: 'auth.refused',
        result: 'refused_missing_secret',
        target: `${method} ${path === '/leads/1' ? '/leads/:id' : path}`,
        ip: CALLER_IP,
        user_agent: CALLER_UA,
      })
    })

    it.each(routes)('wrong secret on %s %s -> refused_wrong_secret', async (method, path, body) => {
      const { response, row } = await callAndGetAuditRow(request(method, path, { secret: `${SECRET}-wrong`, body }))
      expect(response.status).toBe(401)
      expect(row).toMatchObject({ actor: 'anonymous', action: 'auth.refused', result: 'refused_wrong_secret' })
    })

    it('a non-Bearer scheme counts as a missing secret', async () => {
      const { response, row } = await callAndGetAuditRow(
        request('GET', '/leads', { secret: null, headers: { Authorization: `Basic ${SECRET}` } })
      )
      expect(response.status).toBe(401)
      expect(row).toMatchObject({ action: 'auth.refused', result: 'refused_missing_secret' })
    })

    it('an unset server secret refuses with 500 and one row', async () => {
      const { response, row } = await callAndGetAuditRow(request('GET', '/leads', { secret: 'anything' }), {
        LEADS_API_SECRET: '',
      })
      expect(response.status).toBe(500)
      expect(row).toMatchObject({ actor: 'anonymous', action: 'auth.refused', result: 'refused_server_misconfigured' })
    })

    it('a refused request writes nothing to inbound_leads', async () => {
      const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbound_leads').first<{ n: number }>()
      await call(request('POST', '/leads', { secret: 'wrong', body: LEAD }))
      const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbound_leads').first<{ n: number }>()
      expect(after?.n).toBe(before?.n)
    })
  })

  it('an unknown path writes no audit row', async () => {
    const before = await auditCount()
    expect((await call(request('GET', '/'))).status).toBe(404)
    expect(await auditCount()).toBe(before)
  })

  it('truncates the user agent', async () => {
    const { row } = await callAndGetAuditRow(
      request('GET', '/leads', { headers: { 'User-Agent': 'u'.repeat(1000) } })
    )
    expect(row.user_agent).toHaveLength(USER_AGENT_MAX_LENGTH)
  })

  it('concurrent requests each get their own row and the chain stays linear', async () => {
    const before = await auditCount()
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => call(request('POST', '/leads', { body: LEAD })))
    )
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(201))
    expect(await auditCount()).toBe(before + 12)
    expect((await verifyChain(env.DB)).ok).toBe(true)
  })
})

describe('audit write failure', () => {
  // Fails only the audit INSERT; every other query goes to the real database.
  function dbWithFailingAudit(): D1Database {
    return {
      prepare(sql: string) {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('simulated audit outage')
        return env.DB.prepare(sql)
      },
    } as unknown as D1Database
  }

  it('lead create fails open: the lead is stored, 201, and the failure is logged', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    const response = await call(request('POST', '/leads', { body: LEAD }), { DB: dbWithFailingAudit() })
    expect(response.status).toBe(201)
    expect(errors.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: 'audit_write_failed', action: 'lead.create', result: 'accepted' })
    )
  })

  it('admin list and patch fail closed: 500 and no lead data', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = await createLeadId()
    const failing = { DB: dbWithFailingAudit() }

    const list = await call(request('GET', '/leads'), failing)
    expect(list.status).toBe(500)
    expect(await list.json()).toEqual({ error: 'audit_unavailable' })

    const patch = await call(request('PATCH', `/leads/${id}`, { body: { downloaded: true } }), failing)
    expect(patch.status).toBe(500)
    expect(await patch.json()).toEqual({ error: 'audit_unavailable' })
  })
})

describe('verifyChain', () => {
  async function headRow(): Promise<AuditRow> {
    const row = await env.DB.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 1').first<AuditRow>()
    return row!
  }

  // A row with at least one row after it, so the chain link to its successor is tested too.
  async function middleRow(): Promise<AuditRow> {
    await call(request('GET', '/leads', { secret: null }))
    const { response } = await callAndGetAuditRow(request('GET', '/leads', { secret: null }))
    const [row] = await auditRowsFor(response.headers.get('X-Request-Id')!)
    await call(request('GET', '/leads', { secret: null }))
    return row
  }

  it('passes on a clean log and reports the head', async () => {
    await call(request('POST', '/leads', { body: LEAD }))
    const head = await headRow()
    expect(await verifyChain(env.DB)).toEqual({
      ok: true,
      rows: await auditCount(),
      head_id: head.id,
      head_hash: head.row_hash,
    })
  })

  it('passes across page boundaries', async () => {
    expect((await verifyChain(env.DB, 3)).ok).toBe(true)
  })

  it('the database refuses UPDATE and DELETE on audit_events', async () => {
    await expect(env.DB.prepare(`UPDATE audit_events SET result = 'ok'`).run()).rejects.toThrow(/append-only/)
    await expect(env.DB.prepare('DELETE FROM audit_events').run()).rejects.toThrow(/append-only/)
  })

  it('fails after a row is altered, and passes again once it is restored', async () => {
    const row = await middleRow()
    try {
      await env.DB.exec('DROP TRIGGER audit_events_no_update')
      await env.DB.prepare(`UPDATE audit_events SET result = 'ok' WHERE id = ?`).bind(row.id).run()

      expect(await verifyChain(env.DB)).toEqual({
        ok: false,
        rows_checked: row.id - 1,
        broken_at_id: row.id,
        reason: 'row_hash does not match the row contents',
      })

      await env.DB.prepare('UPDATE audit_events SET result = ? WHERE id = ?').bind(row.result, row.id).run()
    } finally {
      await restoreTriggers()
    }
    expect((await verifyChain(env.DB)).ok).toBe(true)
  })

  it('fails at the next row when an altered row also gets a recomputed hash', async () => {
    const row = await middleRow()
    try {
      await env.DB.exec('DROP TRIGGER audit_events_no_update')
      const forged = { ...row, result: 'ok' }
      await env.DB.prepare('UPDATE audit_events SET result = ?, row_hash = ? WHERE id = ?')
        .bind(forged.result, await computeRowHash(forged), row.id)
        .run()

      expect(await verifyChain(env.DB)).toMatchObject({
        ok: false,
        broken_at_id: row.id + 1,
        reason: 'prev_hash does not match the previous row_hash',
      })

      await env.DB.prepare('UPDATE audit_events SET result = ?, row_hash = ? WHERE id = ?')
        .bind(row.result, row.row_hash, row.id)
        .run()
    } finally {
      await restoreTriggers()
    }
    expect((await verifyChain(env.DB)).ok).toBe(true)
  })

  it('fails when a row is deleted from the middle', async () => {
    const row = await middleRow()
    try {
      await env.DB.exec('DROP TRIGGER audit_events_no_delete')
      await env.DB.prepare('DELETE FROM audit_events WHERE id = ?').bind(row.id).run()

      expect(await verifyChain(env.DB)).toMatchObject({ ok: false, broken_at_id: row.id + 1, reason: `expected id ${row.id}` })

      await env.DB.prepare(
        `INSERT INTO audit_events (id, ts, request_id, actor, action, target, result, ip, user_agent, prev_hash, row_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(row.id, row.ts, row.request_id, row.actor, row.action, row.target, row.result, row.ip, row.user_agent, row.prev_hash, row.row_hash)
        .run()
    } finally {
      await restoreTriggers()
    }
    expect((await verifyChain(env.DB)).ok).toBe(true)
  })
})

describe('no secrets or personal data in audit rows or logs', () => {
  it('scans every audit row and every captured log line', async () => {
    // Generated now, so the scan cannot pass by accident on a value that appears elsewhere.
    const secret = `dummy-scan-secret-${crypto.randomUUID()}`
    const email = `scan.${crypto.randomUUID().slice(0, 8)}@example.com`
    const phone = '555-0187'
    const name = `Scan Person ${crypto.randomUUID().slice(0, 8)}`
    const lead = { ...LEAD, name, email, budget: `call ${phone}`, transcript: `[{"role":"user","content":"${email} ${phone}"}]` }
    const as = { secret }
    const withSecret = { LEADS_API_SECRET: secret }

    const lines: string[] = []
    const capture = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation(capture)
    }

    const created = await call(request('POST', '/leads', { ...as, body: lead }), withSecret)
    expect(created.status).toBe(201)
    const { id } = await created.json<{ id: number }>()

    const requests = [
      request('POST', '/leads', { ...as, body: { ...lead, name: '' } }), // validation-rejected
      request('POST', '/leads', { ...as, body: { ...lead, extra: email } }), // unknown field
      request('POST', '/leads', { ...as, body: `{"email":"${email}"` }), // invalid JSON
      request('GET', `/leads?after_id=${id - 1}`, as), // list returns the lead
      request('PATCH', `/leads/${id}`, { ...as, body: { downloaded: true } }),
      request('PATCH', `/leads/${encodeURIComponent(email)}`, { ...as, body: { downloaded: true } }),
      request('POST', '/leads', { secret: null, body: lead }), // missing secret
      request('POST', '/leads', { secret: `${secret}x`, body: lead }), // wrong secret containing the real one
      request('GET', '/leads', { secret: email }), // personal data sent as the secret
      request('PATCH', `/leads/${encodeURIComponent(phone)}`, { secret: null, body: { downloaded: true } }),
      request('GET', `/nowhere/${encodeURIComponent(email)}`, as), // unknown path
    ]
    for (const req of requests) await call(req, withSecret)
    await call(request('POST', '/leads', { ...as, body: lead }), { ...withSecret, LEADS_WRITE_PAUSED: 'true' })
    vi.restoreAllMocks()

    const { results: auditRows } = await env.DB.prepare('SELECT * FROM audit_events').all()
    expect(auditRows.length).toBeGreaterThan(0)
    expect(lines.length).toBeGreaterThanOrEqual(requests.length + 2)

    const haystacks = { audit: JSON.stringify(auditRows), logs: lines.join('\n') }
    for (const [where, text] of Object.entries(haystacks)) {
      for (const needle of [secret, SECRET, email, phone, name, encodeURIComponent(email)]) {
        expect(text.includes(needle), `${where} contains a forbidden value`).toBe(false)
      }
    }

    // Every request log line is structured JSON with the SEC-K fields.
    const requestLines = lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'request')
    expect(requestLines).toHaveLength(requests.length + 2)
    for (const entry of requestLines) {
      expect(entry).toEqual(
        expect.objectContaining({
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          route: expect.any(String),
          status: expect.any(Number),
          duration_ms: expect.any(Number),
        })
      )
    }
  })

  it('the request log line matches the response and points at the audit row', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line))
    const response = await call(request('GET', '/leads?limit=1'))
    vi.restoreAllMocks()

    const requestId = response.headers.get('X-Request-Id')!
    const [row] = await auditRowsFor(requestId)
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({
      level: 'info',
      event: 'request',
      request_id: requestId,
      route: 'GET /leads',
      status: 200,
      duration_ms: expect.any(Number),
      audit_id: row.id,
      audit_hash: row.row_hash,
    })
  })
})
