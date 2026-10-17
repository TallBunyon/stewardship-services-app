import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handler } from '../netlify/functions/submit-lead'
import {
  SUPABASE_KEY,
  SUPABASE_URL,
  WORKER_SECRET,
  WORKER_URL,
  hosts,
  invoke,
  jsonResponse,
  mockFetch,
  postEvent,
  textResponse,
  type Responder,
} from './helpers'

// Placeholder lead (example.com is reserved for documentation).
const LEAD = {
  name: 'Test Person',
  email: 'test.person@example.com',
  org: 'Example Org',
  service: 'Web design',
  summary: 'Needs a five-page site',
  budget: '$2k',
  timeline: 'next month',
  transcript: '[{"role":"user","content":"hi"}]',
}

function setup(options: { supabase?: Responder; worker?: Responder; resend?: Responder } = {}) {
  return mockFetch({
    [SUPABASE_URL]: options.supabase ?? (() => textResponse(201)),
    [WORKER_URL]: options.worker ?? (() => jsonResponse(201, { id: 7 })),
    'https://api.resend.com/': options.resend ?? (() => jsonResponse(200, { id: 'email' })),
  })
}

async function submit(lead: Record<string, unknown> = LEAD) {
  return invoke(handler, postEvent(lead))
}

const EXPECTED_WORKER_BODY = {
  name: LEAD.name,
  email: LEAD.email,
  budget: LEAD.budget,
  timeline: LEAD.timeline,
  transcript: LEAD.transcript,
  source: 'steward-services',
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE_URL)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_KEY)
  vi.stubEnv('LEADS_API_URL', WORKER_URL)
  vi.stubEnv('LEADS_API_SECRET', WORKER_SECRET)
  vi.stubEnv('RESEND_API_KEY', 'test-resend-placeholder')
  vi.stubEnv('NOTIFY_EMAIL', 'notify@example.com')
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '')
  vi.stubEnv('TELEGRAM_CHAT_ID', '')
  vi.stubEnv('LEADS_BACKEND', undefined)
})

describe('submit-lead.ts LEADS_BACKEND=supabase (default)', () => {
  it('writes to Supabase exactly as before and never calls the Worker', async () => {
    const { calls } = setup()
    const response = await submit()

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body ?? '{}')).toEqual({ ok: true })
    expect(hosts(calls)).toEqual(['supabase.test', 'api.resend.com'])
    expect(calls[0]).toMatchObject({
      url: `${SUPABASE_URL}/rest/v1/inbound_leads`,
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        authorization: `Bearer ${SUPABASE_KEY}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: {
        name: LEAD.name,
        email: LEAD.email,
        budget: LEAD.budget,
        timeline: LEAD.timeline,
        transcript: LEAD.transcript,
        source: 'steward-services',
      },
    })
    expect((calls[0].body as { created_at: string }).created_at).toMatch(/Z$/)
  })

  it('502 message is unchanged when persistence and notifications all fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ supabase: () => textResponse(500), resend: () => textResponse(500) })
    const response = await submit()
    expect(response.statusCode).toBe(502)
    expect(response.body).toMatch(/^Supabase persistence failed; /)
  })
})

describe('submit-lead.ts LEADS_BACKEND=dual', () => {
  beforeEach(() => {
    vi.stubEnv('LEADS_BACKEND', 'dual')
  })

  it('writes to Supabase first, then to the Worker', async () => {
    const { calls } = setup()
    const response = await submit()
    expect(response.statusCode).toBe(200)
    expect(hosts(calls)).toEqual(['supabase.test', 'leads-api.test', 'api.resend.com'])
    expect(calls[1]).toMatchObject({
      url: `${WORKER_URL}/leads`,
      headers: { authorization: `Bearer ${WORKER_SECRET}` },
      body: EXPECTED_WORKER_BODY,
    })
  })

  it('a Worker failure still succeeds for the user', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ worker: () => jsonResponse(400, { error: 'validation_failed' }) })
    const response = await submit()
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body ?? '{}')).toEqual({ ok: true })
    expect(error).toHaveBeenCalledWith(
      '[submit-lead] Dual write: Worker save failed (user unaffected):',
      expect.stringContaining('400')
    )
  })

  it('a Worker failure plus a notification failure still succeeds (Supabase saved the lead)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({
      worker: () => {
        throw new TypeError('fetch failed')
      },
      resend: () => textResponse(500),
    })
    const response = await submit()
    expect(response.statusCode).toBe(200)
  })

  it('the user-visible outcome is still Supabase\'s: Supabase + notifications failing gives the same 502', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { calls } = setup({ supabase: () => textResponse(500), resend: () => textResponse(500) })
    const response = await submit()
    expect(response.statusCode).toBe(502)
    expect(response.body).toMatch(/^Supabase persistence failed; /)
    // The Worker was still written, so the lead is not lost.
    expect(hosts(calls)).toContain('leads-api.test')
  })
})

describe('submit-lead.ts LEADS_BACKEND=worker', () => {
  beforeEach(() => {
    vi.stubEnv('LEADS_BACKEND', 'worker')
  })

  it('writes to the Worker only (no Supabase call)', async () => {
    const { calls } = setup()
    const response = await submit()
    expect(response.statusCode).toBe(200)
    expect(hosts(calls)).toEqual(['leads-api.test', 'api.resend.com'])
    expect(calls[0].body).toEqual(EXPECTED_WORKER_BODY)
  })

  it('falls back to summary when there is no transcript, as the Supabase path does', async () => {
    const { calls } = setup()
    const { transcript: _omit, ...lead } = LEAD
    await submit(lead)
    expect((calls[0].body as { transcript: string }).transcript).toBe(LEAD.summary)
  })

  it('a Worker failure with a successful notification still returns 200', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ worker: () => jsonResponse(503, { error: 'writes_paused' }) })
    expect((await submit()).statusCode).toBe(200)
  })

  it('a Worker failure plus notification failures returns 502 naming the Worker', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ worker: () => jsonResponse(500, { error: 'internal_error' }), resend: () => textResponse(500) })
    const response = await submit()
    expect(response.statusCode).toBe(502)
    expect(response.body).toMatch(/^Worker persistence failed; /)
    expect(error).toHaveBeenCalledWith('[submit-lead] Worker persistence error:', expect.any(Error))
  })
})
