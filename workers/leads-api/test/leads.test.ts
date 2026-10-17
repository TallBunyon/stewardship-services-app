import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import worker, { MAX_BODY_BYTES, PAUSED_RETRY_AFTER_SECONDS } from '../src/index'
import { LIMITS } from '../src/validate'

// Matches the test-only binding in vitest.config.ts. Not a real secret.
const SECRET = 'test-only-placeholder-secret'
const BASE = 'https://leads-api.test'

type EnvOverrides = Partial<Record<keyof Env, unknown>>

// Calls the Worker's fetch handler directly so individual tests can override vars
// (LEADS_WRITE_PAUSED, LEADS_ALLOW_TRANSCRIPT_ONLY, LEADS_API_SECRET).
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

function authHeaders(secret: string | null = SECRET): Record<string, string> {
  return secret === null ? {} : { Authorization: `Bearer ${secret}` }
}

function postLead(body: unknown, secret: string | null = SECRET): Request {
  return new Request(`${BASE}/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(secret) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function getLeads(query = '', secret: string | null = SECRET): Request {
  return new Request(`${BASE}/leads${query}`, { headers: authHeaders(secret) })
}

function patchLead(id: number | string, body: unknown, secret: string | null = SECRET): Request {
  return new Request(`${BASE}/leads/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(secret) },
    body: JSON.stringify(body),
  })
}

// Placeholder data only (example.com is reserved for documentation).
const VALID_LEAD = {
  name: 'Test Person',
  email: 'test.person@example.com',
  budget: '$1k-$5k',
  timeline: '1-2 months',
  transcript: '[{"role":"user","content":"I need a website"}]',
  source: 'steward-services',
}

// The exact shape chat.ts writes today: no name, no email.
const TRANSCRIPT_ONLY_LEAD = {
  transcript: '[{"role":"user","content":"I need a website"}]',
  source: 'steward-services',
}

async function countRows(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbound_leads').first<{ n: number }>()
  return row?.n ?? 0
}

beforeEach(async () => {
  // Storage is per test file; clear the table so each test starts empty.
  await env.DB.exec('DELETE FROM inbound_leads')
})

describe('POST /leads', () => {
  it('valid insert returns 201 with the id and stores the row', async () => {
    const response = await call(postLead(VALID_LEAD))
    expect(response.status).toBe(201)

    const body = await response.json<{ id: number }>()
    expect(Number.isInteger(body.id)).toBe(true)
    expect(response.headers.get('Location')).toBe(`/leads/${body.id}`)

    const row = await env.DB.prepare('SELECT * FROM inbound_leads WHERE id = ?')
      .bind(body.id)
      .first<Record<string, unknown>>()
    expect(row).toMatchObject({ ...VALID_LEAD, id: body.id, downloaded: 0 })
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('accepts a minimal lead (name, email, source) and stores nulls for the rest', async () => {
    const response = await call(
      postLead({ name: 'A', email: 'a@example.com', source: 'steward-services' })
    )
    expect(response.status).toBe(201)
    const { id } = await response.json<{ id: number }>()
    const row = await env.DB.prepare('SELECT budget, timeline, transcript FROM inbound_leads WHERE id = ?')
      .bind(id)
      .first()
    expect(row).toEqual({ budget: null, timeline: null, transcript: null })
  })

  it('assigns increasing ids', async () => {
    const first = await (await call(postLead(VALID_LEAD))).json<{ id: number }>()
    const second = await (await call(postLead(VALID_LEAD))).json<{ id: number }>()
    expect(second.id).toBeGreaterThan(first.id)
  })

  it('empty name returns 400', async () => {
    const response = await call(postLead({ ...VALID_LEAD, name: '' }))
    expect(response.status).toBe(400)
    const body = await response.json<{ error: string; details: string[] }>()
    expect(body.error).toBe('validation_failed')
    expect(body.details).toContain('name is required')
    expect(await countRows()).toBe(0)
  })

  it('missing name returns 400', async () => {
    const { name: _omit, ...lead } = VALID_LEAD
    const response = await call(postLead(lead))
    expect(response.status).toBe(400)
    expect((await response.json<{ details: string[] }>()).details).toContain('name is required')
  })

  it('missing email returns 400', async () => {
    const { email: _omit, ...lead } = VALID_LEAD
    const response = await call(postLead(lead))
    expect(response.status).toBe(400)
    expect((await response.json<{ details: string[] }>()).details).toContain('email is required')
    expect(await countRows()).toBe(0)
  })

  it('null email returns 400', async () => {
    const response = await call(postLead({ ...VALID_LEAD, email: null }))
    expect(response.status).toBe(400)
  })

  it.each([
    'not-an-email',
    'missing-at.example.com',
    'user@nodot',
    'user@example.c',
    'user name@example.com',
    'user@exa mple.com',
    '@example.com',
    'user@example.com ',
    ' user@example.com',
    'user@example.com\nextra',
    '',
  ])('bad email %j returns 400', async (email) => {
    const response = await call(postLead({ ...VALID_LEAD, email }))
    expect(response.status).toBe(400)
    expect((await response.json<{ details: string[] }>()).details).toContain(
      'email is not a valid address'
    )
    expect(await countRows()).toBe(0)
  })

  it.each(['UPPER.CASE@EXAMPLE.COM', 'first+tag@example.co.uk', 'a_b%c-d@sub-domain.example.org'])(
    'email %j accepted by the live regex is accepted',
    async (email) => {
      expect((await call(postLead({ ...VALID_LEAD, email }))).status).toBe(201)
    }
  )

  it('whitespace-only name is accepted, matching Postgres `name <> \'\'`', async () => {
    expect((await call(postLead({ ...VALID_LEAD, name: '   ' }))).status).toBe(201)
  })

  it('missing source returns 400', async () => {
    const { source: _omit, ...lead } = VALID_LEAD
    const response = await call(postLead(lead))
    expect(response.status).toBe(400)
    expect((await response.json<{ details: string[] }>()).details).toContain('source is required')
  })

  it.each(['id', 'created_at', 'downloaded', 'org'])(
    'client-supplied field %j is rejected with 400',
    async (field) => {
      const response = await call(postLead({ ...VALID_LEAD, [field]: 1 }))
      expect(response.status).toBe(400)
      expect((await response.json<{ details: string[] }>()).details).toContain(
        `unknown field: ${field}`
      )
    }
  )

  it('non-string field types return 400', async () => {
    const response = await call(postLead({ ...VALID_LEAD, budget: 5000 }))
    expect(response.status).toBe(400)
    expect((await response.json<{ details: string[] }>()).details).toContain(
      'budget must be a string or null'
    )
  })

  it.each(['[]', '"text"', 'null', '42'])('non-object JSON body %s returns 400', async (raw) => {
    expect((await call(postLead(raw))).status).toBe(400)
  })

  it.each(Object.entries(LIMITS))('%s longer than %i characters returns 400', async (field, max) => {
    const tooLong = field === 'email' ? `${'a'.repeat(max)}@example.com` : 'x'.repeat(max + 1)
    const response = await call(postLead({ ...VALID_LEAD, [field]: tooLong }))
    expect(response.status).toBe(400)
    expect((await response.json<{ details: string[] }>()).details).toContain(
      `${field} must be at most ${max} characters`
    )
  })

  it('fields exactly at their length limits are accepted', async () => {
    const atLimit = {
      name: 'n'.repeat(LIMITS.name),
      email: `${'e'.repeat(LIMITS.email - '@example.com'.length)}@example.com`,
      budget: 'b'.repeat(LIMITS.budget),
      timeline: 't'.repeat(LIMITS.timeline),
      transcript: 'x'.repeat(LIMITS.transcript),
      source: 's'.repeat(LIMITS.source),
    }
    expect(atLimit.email.length).toBe(LIMITS.email)
    expect((await call(postLead(atLimit))).status).toBe(201)
  })

  it('body larger than the byte limit returns 413', async () => {
    const response = await call(postLead({ ...VALID_LEAD, transcript: 'x'.repeat(MAX_BODY_BYTES) }))
    expect(response.status).toBe(413)
    expect(await countRows()).toBe(0)
  })

  it('invalid JSON returns 400', async () => {
    const response = await call(postLead('{"name": '))
    expect(response.status).toBe(400)
    expect((await response.json<{ error: string }>()).error).toBe('invalid_json')
  })

  it('non-JSON content type returns 415', async () => {
    const request = new Request(`${BASE}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...authHeaders() },
      body: JSON.stringify(VALID_LEAD),
    })
    expect((await call(request)).status).toBe(415)
  })

  describe('LEADS_ALLOW_TRANSCRIPT_ONLY', () => {
    it('default ("false"): transcript-only lead (chat.ts shape) returns 400', async () => {
      const response = await call(postLead(TRANSCRIPT_ONLY_LEAD))
      expect(response.status).toBe(400)
      const { details } = await response.json<{ details: string[] }>()
      expect(details).toEqual(expect.arrayContaining(['name is required', 'email is required']))
    })

    it('"true": transcript-only lead returns 201 and stores null name/email', async () => {
      const response = await call(postLead(TRANSCRIPT_ONLY_LEAD), {
        LEADS_ALLOW_TRANSCRIPT_ONLY: 'true',
      })
      expect(response.status).toBe(201)
      const { id } = await response.json<{ id: number }>()
      const row = await env.DB.prepare('SELECT name, email, transcript FROM inbound_leads WHERE id = ?')
        .bind(id)
        .first()
      expect(row).toEqual({ name: null, email: null, transcript: TRANSCRIPT_ONLY_LEAD.transcript })
    })

    it('"true": still rejects a bad email, a name without email, and an empty transcript', async () => {
      const overrides = { LEADS_ALLOW_TRANSCRIPT_ONLY: 'true' }
      const cases = [
        { ...TRANSCRIPT_ONLY_LEAD, email: 'not-an-email' },
        { ...TRANSCRIPT_ONLY_LEAD, name: 'Only Name' },
        { ...TRANSCRIPT_ONLY_LEAD, email: 'only.email@example.com' },
        { ...TRANSCRIPT_ONLY_LEAD, transcript: '   ' },
        { source: 'steward-services' },
      ]
      for (const lead of cases) {
        expect((await call(postLead(lead), overrides)).status, JSON.stringify(lead)).toBe(400)
      }
      expect(await countRows()).toBe(0)
    })
  })

  describe('auth', () => {
    it('missing secret returns 401 with WWW-Authenticate', async () => {
      const response = await call(postLead(VALID_LEAD, null))
      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
      expect(await countRows()).toBe(0)
    })

    it('wrong secret returns 401', async () => {
      expect((await call(postLead(VALID_LEAD, 'wrong-secret'))).status).toBe(401)
      expect(await countRows()).toBe(0)
    })

    it('secret that is a prefix of the real one returns 401', async () => {
      expect((await call(postLead(VALID_LEAD, SECRET.slice(0, -1)))).status).toBe(401)
    })

    it('non-Bearer scheme returns 401', async () => {
      const request = new Request(`${BASE}/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${SECRET}` },
        body: JSON.stringify(VALID_LEAD),
      })
      expect((await call(request)).status).toBe(401)
    })

    it('returns 500 and accepts nothing when LEADS_API_SECRET is not configured', async () => {
      const response = await call(postLead(VALID_LEAD, ''), { LEADS_API_SECRET: '' })
      expect(response.status).toBe(500)
      expect((await response.json<{ error: string }>()).error).toBe('server_misconfigured')
      expect(await countRows()).toBe(0)
    })
  })

  describe('LEADS_WRITE_PAUSED', () => {
    it('"true": returns 503 with Retry-After and inserts nothing', async () => {
      const response = await call(postLead(VALID_LEAD), { LEADS_WRITE_PAUSED: 'true' })
      expect(response.status).toBe(503)
      expect(response.headers.get('Retry-After')).toBe(String(PAUSED_RETRY_AFTER_SECONDS))
      expect((await response.json<{ error: string }>()).error).toBe('writes_paused')
      expect(await countRows()).toBe(0)
    })

    it('"true": auth is still checked first (401 for a wrong secret)', async () => {
      const response = await call(postLead(VALID_LEAD, 'wrong-secret'), { LEADS_WRITE_PAUSED: 'true' })
      expect(response.status).toBe(401)
    })

    it('"true": admin GET and PATCH keep working', async () => {
      const { id } = await (await call(postLead(VALID_LEAD))).json<{ id: number }>()
      const paused = { LEADS_WRITE_PAUSED: 'true' }
      expect((await call(getLeads(), paused)).status).toBe(200)
      expect((await call(patchLead(id, { downloaded: true }), paused)).status).toBe(200)
    })

    it('any value other than "true" does not pause', async () => {
      expect((await call(postLead(VALID_LEAD), { LEADS_WRITE_PAUSED: 'TRUE ' })).status).toBe(201)
    })
  })
})

describe('GET /leads (admin)', () => {
  async function seed(n: number): Promise<number[]> {
    const ids: number[] = []
    for (let i = 0; i < n; i++) {
      const { id } = await (await call(postLead({ ...VALID_LEAD, name: `Lead ${i}` }))).json<{
        id: number
      }>()
      ids.push(id)
    }
    return ids
  }

  it('missing secret returns 401', async () => {
    expect((await call(getLeads('', null))).status).toBe(401)
  })

  it('wrong secret returns 401', async () => {
    expect((await call(getLeads('', 'wrong-secret'))).status).toBe(401)
  })

  it('lists leads oldest first with downloaded as a boolean', async () => {
    const ids = await seed(3)
    const response = await call(getLeads())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')

    const body = await response.json<{ leads: Array<Record<string, unknown>>; next_after_id: number | null }>()
    expect(body.leads.map((lead) => lead.id)).toEqual(ids)
    expect(body.leads[0]).toMatchObject({ ...VALID_LEAD, name: 'Lead 0', downloaded: false })
    expect(body.next_after_id).toBeNull()
  })

  it('filters by downloaded', async () => {
    const [first, second] = await seed(2)
    await call(patchLead(first, { downloaded: true }))

    const unread = await (await call(getLeads('?downloaded=false'))).json<{ leads: Array<{ id: number }> }>()
    expect(unread.leads.map((lead) => lead.id)).toEqual([second])

    const read = await (await call(getLeads('?downloaded=true'))).json<{ leads: Array<{ id: number }> }>()
    expect(read.leads.map((lead) => lead.id)).toEqual([first])
  })

  it('paginates with limit and after_id', async () => {
    const ids = await seed(5)
    const page1 = await (await call(getLeads('?limit=2'))).json<{
      leads: Array<{ id: number }>
      next_after_id: number | null
    }>()
    expect(page1.leads.map((lead) => lead.id)).toEqual(ids.slice(0, 2))
    expect(page1.next_after_id).toBe(ids[1])

    const page2 = await (await call(getLeads(`?limit=2&after_id=${page1.next_after_id}`))).json<{
      leads: Array<{ id: number }>
    }>()
    expect(page2.leads.map((lead) => lead.id)).toEqual(ids.slice(2, 4))
  })

  it.each(['?downloaded=yes', '?limit=0', '?limit=501', '?limit=abc', '?after_id=-1'])(
    'invalid query %s returns 400',
    async (query) => {
      expect((await call(getLeads(query))).status).toBe(400)
    }
  )
})

describe('PATCH /leads/:id (admin)', () => {
  async function createOne(): Promise<number> {
    return (await (await call(postLead(VALID_LEAD))).json<{ id: number }>()).id
  }

  it('missing secret returns 401 and changes nothing', async () => {
    const id = await createOne()
    expect((await call(patchLead(id, { downloaded: true }, null))).status).toBe(401)
    const row = await env.DB.prepare('SELECT downloaded FROM inbound_leads WHERE id = ?').bind(id).first()
    expect(row).toEqual({ downloaded: 0 })
  })

  it('wrong secret returns 401', async () => {
    const id = await createOne()
    expect((await call(patchLead(id, { downloaded: true }, 'wrong-secret'))).status).toBe(401)
  })

  it('sets downloaded to true and back to false', async () => {
    const id = await createOne()

    const setTrue = await call(patchLead(id, { downloaded: true }))
    expect(setTrue.status).toBe(200)
    expect((await setTrue.json<{ lead: { id: number; downloaded: boolean } }>()).lead).toMatchObject({
      id,
      downloaded: true,
    })
    const stored = await env.DB.prepare('SELECT downloaded FROM inbound_leads WHERE id = ?').bind(id).first()
    expect(stored).toEqual({ downloaded: 1 })

    const setFalse = await call(patchLead(id, { downloaded: false }))
    expect((await setFalse.json<{ lead: { downloaded: boolean } }>()).lead.downloaded).toBe(false)
  })

  it('unknown id returns 404', async () => {
    expect((await call(patchLead(999999, { downloaded: true }))).status).toBe(404)
  })

  it.each(['abc', '0', '-1', '1.5'])('invalid id %j returns 400', async (id) => {
    expect((await call(patchLead(id, { downloaded: true }))).status).toBe(400)
  })

  it.each([{}, { downloaded: 'true' }, { downloaded: 1 }, { downloaded: true, name: 'x' }])(
    'invalid body %j returns 400',
    async (body) => {
      const id = await createOne()
      expect((await call(patchLead(id, body))).status).toBe(400)
    }
  )
})

describe('routing', () => {
  it('unknown path returns 404', async () => {
    expect((await call(new Request(`${BASE}/`, { headers: authHeaders() }))).status).toBe(404)
    expect((await call(new Request(`${BASE}/leads/1/extra`, { headers: authHeaders() }))).status).toBe(404)
  })

  it('unsupported method returns 405 with Allow', async () => {
    const response = await call(new Request(`${BASE}/leads`, { method: 'DELETE', headers: authHeaders() }))
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET, POST')

    const itemResponse = await call(new Request(`${BASE}/leads/1`, { method: 'GET', headers: authHeaders() }))
    expect(itemResponse.status).toBe(405)
    expect(itemResponse.headers.get('Allow')).toBe('PATCH')
  })
})

describe('deployed configuration (wrangler.jsonc vars, via exports.default.fetch)', () => {
  it('writes are not paused and the strict live rule applies by default', async () => {
    expect(env.LEADS_WRITE_PAUSED).toBe('false')
    expect(env.LEADS_ALLOW_TRANSCRIPT_ONLY).toBe('false')

    const created = await exports.default.fetch(postLead(VALID_LEAD))
    expect(created.status).toBe(201)

    const transcriptOnly = await exports.default.fetch(postLead(TRANSCRIPT_ONLY_LEAD))
    expect(transcriptOnly.status).toBe(400)
  })
})

describe('migration (supports the SV-2 import)', () => {
  it('keeps imported ids and continues numbering after the highest one', async () => {
    await env.DB.prepare(
      `INSERT INTO inbound_leads (id, created_at, name, email, transcript, source, downloaded)
       VALUES (41, '2026-09-01T12:00:00.000Z', NULL, NULL, '[]', 'steward-services', 1)`
    ).run()

    const { id } = await (await call(postLead(VALID_LEAD))).json<{ id: number }>()
    expect(id).toBe(42)
  })

  it('defaults created_at to an ISO-8601 UTC string and downloaded to 0', async () => {
    await env.DB.prepare(`INSERT INTO inbound_leads (source) VALUES ('steward-services')`).run()
    const row = await env.DB.prepare('SELECT created_at, downloaded FROM inbound_leads').first<{
      created_at: string
      downloaded: number
    }>()
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(row?.downloaded).toBe(0)
  })

  it.each([
    ["created_at in Postgres text format", `INSERT INTO inbound_leads (created_at, source) VALUES ('2026-09-01 12:00:00+00', 's')`],
    ['an impossible date', `INSERT INTO inbound_leads (created_at, source) VALUES ('2026-13-45T99:99:99Z', 's')`],
    ['downloaded outside 0/1', `INSERT INTO inbound_leads (source, downloaded) VALUES ('s', 2)`],
    ['missing source', `INSERT INTO inbound_leads (name) VALUES ('x')`],
  ])('rejects %s', async (_label, sql) => {
    await expect(env.DB.prepare(sql).run()).rejects.toThrow()
  })
})
