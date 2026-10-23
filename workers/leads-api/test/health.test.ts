import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// GET | HEAD /health: liveness for uptime monitors (staging runbook section 5.2). No secret,
// no audit row, one request log line whose route is the template `GET /health`.
//
// audit_events is append-only, so rows accumulate across the tests in this file. Each test that
// cares counts rows before and after.

const SECRET = env.LEADS_API_SECRET // dummy generated per run in vitest.config.ts
const BASE = 'https://leads-api.test'

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

async function auditCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_events').first<{ n: number }>()
  return row?.n ?? 0
}

async function leadCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbound_leads').first<{ n: number }>()
  return row?.n ?? 0
}

// Runs `fn` with console.log captured and returns the parsed JSON log lines.
async function captureLogs(fn: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line))
  vi.spyOn(console, 'warn').mockImplementation((line: string) => lines.push(line))
  vi.spyOn(console, 'error').mockImplementation((line: string) => lines.push(line))
  try {
    await fn()
  } finally {
    vi.restoreAllMocks()
  }
  return lines.map((line) => JSON.parse(line))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /health', () => {
  it('returns 200 {"status":"ok"} with Cache-Control: no-store, without any Authorization header', async () => {
    const response = await call(new Request(`${BASE}/health`))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(await response.text()).toBe('{"status":"ok"}')
  })

  it('returns exactly one field: no version, environment or other detail', async () => {
    const response = await call(new Request(`${BASE}/health`))
    expect(await response.json()).toStrictEqual({ status: 'ok' })
  })

  it('carries X-Request-Id, like every other response', async () => {
    const response = await call(new Request(`${BASE}/health`))
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('works through the deployed entrypoint (exports.default.fetch)', async () => {
    const response = await exports.default.fetch(new Request(`${BASE}/health`))
    expect(response.status).toBe(200)
    expect(await response.json()).toStrictEqual({ status: 'ok' })
  })

  it('ignores an Authorization header and a query string', async () => {
    const response = await call(
      new Request(`${BASE}/health?probe=1`, { headers: { Authorization: 'Bearer not-the-secret' } })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toStrictEqual({ status: 'ok' })
  })
})

describe('HEAD /health', () => {
  it('returns 200 and the same headers with an empty body', async () => {
    const response = await call(new Request(`${BASE}/health`, { method: 'HEAD' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(await response.text()).toBe('')
  })
})

describe('no audit row', () => {
  it('GET and HEAD /health write nothing: no audit row, no lead row', async () => {
    const auditBefore = await auditCount()
    const leadsBefore = await leadCount()

    const get = await call(new Request(`${BASE}/health`))
    const head = await call(new Request(`${BASE}/health`, { method: 'HEAD' }))
    expect(get.status).toBe(200)
    expect(head.status).toBe(200)

    expect(await auditCount()).toBe(auditBefore)
    expect(await leadCount()).toBe(leadsBefore)
    for (const response of [get, head]) {
      const { results } = await env.DB.prepare('SELECT id FROM audit_events WHERE request_id = ?')
        .bind(response.headers.get('X-Request-Id'))
        .all()
      expect(results).toHaveLength(0)
    }
  })

  it('does not pollute the auth.refused signal: only the unauthenticated /leads request is audited', async () => {
    const before = await auditCount()
    await call(new Request(`${BASE}/health`))
    await call(new Request(`${BASE}/health`))
    const refused = await call(new Request(`${BASE}/leads`))
    expect(refused.status).toBe(401)
    expect(await auditCount()).toBe(before + 1)

    const row = await env.DB.prepare('SELECT action, result, target FROM audit_events WHERE request_id = ?')
      .bind(refused.headers.get('X-Request-Id'))
      .first()
    expect(row).toEqual({ action: 'auth.refused', result: 'refused_missing_secret', target: 'GET /leads' })
  })
})

describe('request log line', () => {
  it('GET /health writes one structured line with route "GET /health" and no audit fields set', async () => {
    let requestId = ''
    const entries = await captureLogs(async () => {
      const response = await call(new Request(`${BASE}/health?probe=secretish`))
      requestId = response.headers.get('X-Request-Id')!
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toStrictEqual({
      level: 'info',
      event: 'request',
      request_id: requestId,
      route: 'GET /health',
      status: 200,
      duration_ms: expect.any(Number),
      audit_id: null,
      audit_hash: null,
    })
    // The query string never reaches the log.
    expect(JSON.stringify(entries)).not.toContain('probe')
  })

  it('HEAD /health logs the route template "HEAD /health"', async () => {
    const entries = await captureLogs(() => call(new Request(`${BASE}/health`, { method: 'HEAD' })))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ event: 'request', route: 'HEAD /health', status: 200 })
  })
})

describe('other paths are unchanged', () => {
  it.each([
    ['/health/', 'GET'],
    ['/health/extra', 'GET'],
    ['/healthz', 'GET'],
    ['/Health', 'GET'],
    ['/', 'GET'],
    ['/health', 'POST'],
    ['/health', 'PUT'],
    ['/health', 'PATCH'],
    ['/health', 'DELETE'],
    ['/health', 'OPTIONS'],
  ])('%s with %s is still a 404 that writes no audit row', async (path, method) => {
    const before = await auditCount()
    const response = await call(new Request(`${BASE}${path}`, { method }))
    expect(response.status).toBe(404)
    expect(await response.json()).toStrictEqual({ error: 'not_found' })
    expect(await auditCount()).toBe(before)
  })

  it('a non-GET/HEAD request to /health is logged as unmatched, not as the health route', async () => {
    const entries = await captureLogs(() => call(new Request(`${BASE}/health`, { method: 'POST' })))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ route: 'POST (unmatched)', status: 404 })
  })

  it('/leads routes still need the secret', async () => {
    for (const request of [
      new Request(`${BASE}/leads`),
      new Request(`${BASE}/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      new Request(`${BASE}/leads/1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    ]) {
      expect((await call(request)).status).toBe(401)
    }
    const authed = await call(new Request(`${BASE}/leads`, { headers: { Authorization: `Bearer ${SECRET}` } }))
    expect(authed.status).toBe(200)
  })
})
