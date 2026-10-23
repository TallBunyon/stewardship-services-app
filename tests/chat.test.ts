import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handler } from '../netlify/functions/chat'
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

const QUALIFIED_REPLY = 'Got it. Thank you, Bobby will review this and reach out shortly.'
const MESSAGES = [
  { role: 'user', content: 'I need a website for my bakery' },
  { role: 'assistant', content: 'What is your budget, timeline and email?' },
  { role: 'user', content: '$2k, next month, placeholder@example.com' },
]

const openRouter = (content: string): Responder => () =>
  jsonResponse(200, { choices: [{ message: { content } }] })

function setup(options: {
  reply?: string
  supabase?: Responder
  worker?: Responder
} = {}) {
  return mockFetch({
    'https://openrouter.ai/': openRouter(options.reply ?? QUALIFIED_REPLY),
    [SUPABASE_URL]: options.supabase ?? (() => textResponse(201)),
    [WORKER_URL]: options.worker ?? (() => jsonResponse(201, { id: 1 })),
  })
}

async function chat() {
  return invoke(handler, postEvent({ messages: MESSAGES }))
}

// The request chat.ts sent to Supabase before LEADS_BACKEND existed.
const EXPECTED_SUPABASE_REQUEST = {
  url: `${SUPABASE_URL}/rest/v1/inbound_leads`,
  method: 'POST',
  headers: {
    apikey: SUPABASE_KEY,
    authorization: `Bearer ${SUPABASE_KEY}`,
    'content-type': 'application/json',
    prefer: 'return=minimal',
  },
  body: { transcript: JSON.stringify(MESSAGES), source: 'steward-services' },
}

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-placeholder')
  vi.stubEnv('SUPABASE_URL', SUPABASE_URL)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_KEY)
  vi.stubEnv('LEADS_API_URL', WORKER_URL)
  vi.stubEnv('LEADS_API_SECRET', WORKER_SECRET)
  vi.stubEnv('RESEND_API_KEY', '') // notification path is out of scope here
  vi.stubEnv('LEADS_BACKEND', undefined)
})

describe('chat.ts LEADS_BACKEND=supabase (default)', () => {
  it('when unset: writes to Supabase exactly as before and never calls the Worker', async () => {
    const { calls } = setup()
    const response = await chat()

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body ?? '{}')).toEqual({ content: QUALIFIED_REPLY })
    expect(hosts(calls)).toEqual(['openrouter.ai', 'supabase.test'])
    expect(calls[1]).toMatchObject(EXPECTED_SUPABASE_REQUEST)
    expect(calls[1].headers).toEqual(EXPECTED_SUPABASE_REQUEST.headers)
  })

  it('when set to "supabase": same behaviour', async () => {
    vi.stubEnv('LEADS_BACKEND', 'supabase')
    const { calls } = setup()
    expect((await chat()).statusCode).toBe(200)
    expect(hosts(calls)).toEqual(['openrouter.ai', 'supabase.test'])
  })

  it('unknown value falls back to Supabase with a warning', async () => {
    vi.stubEnv('LEADS_BACKEND', 'workers')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { calls } = setup()
    expect((await chat()).statusCode).toBe(200)
    expect(hosts(calls)).toEqual(['openrouter.ai', 'supabase.test'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown LEADS_BACKEND'))
  })

  it('Supabase failure is logged and the chat carries on (unchanged behaviour)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ supabase: () => textResponse(500, 'boom') })
    const response = await chat()
    expect(response.statusCode).toBe(200)
    expect(error).toHaveBeenCalledWith('[chat function] Lead trap door failed:', expect.stringContaining('500'))
  })

  it('does not persist anything until the lead is qualified', async () => {
    const { calls } = setup({ reply: 'What is your budget?' })
    expect((await chat()).statusCode).toBe(200)
    expect(hosts(calls)).toEqual(['openrouter.ai'])
  })
})

describe('chat.ts LEADS_BACKEND=dual', () => {
  beforeEach(() => {
    vi.stubEnv('LEADS_BACKEND', 'dual')
  })

  it('writes to Supabase first (unchanged request), then to the Worker', async () => {
    const { calls } = setup()
    const response = await chat()

    expect(response.statusCode).toBe(200)
    expect(hosts(calls)).toEqual(['openrouter.ai', 'supabase.test', 'leads-api.test'])
    expect(calls[1]).toMatchObject(EXPECTED_SUPABASE_REQUEST)
    expect(calls[2]).toMatchObject({
      url: `${WORKER_URL}/leads`,
      method: 'POST',
      headers: { authorization: `Bearer ${WORKER_SECRET}`, 'content-type': 'application/json' },
      body: { transcript: JSON.stringify(MESSAGES), source: 'steward-services' },
    })
    expect(calls[2].signal).toBeInstanceOf(AbortSignal)
  })

  it('is case-insensitive', async () => {
    vi.stubEnv('LEADS_BACKEND', ' DUAL ')
    const { calls } = setup()
    await chat()
    expect(hosts(calls)).toEqual(['openrouter.ai', 'supabase.test', 'leads-api.test'])
  })

  it('a Worker error response still succeeds for the user and is logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ worker: () => jsonResponse(400, { error: 'validation_failed' }) })

    const response = await chat()
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body ?? '{}')).toEqual({ content: QUALIFIED_REPLY })
    expect(error).toHaveBeenCalledWith(
      '[chat function] Dual write: Worker save failed (user unaffected):',
      expect.stringContaining('400')
    )
    expect(error).not.toHaveBeenCalledWith('[chat function] Lead trap door failed:', expect.anything())
  })

  it('a Worker network failure still succeeds for the user', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({
      worker: () => {
        throw new TypeError('fetch failed')
      },
    })
    const response = await chat()
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body ?? '{}')).toEqual({ content: QUALIFIED_REPLY })
  })

  it('missing Worker env still succeeds for the user and Supabase is written', async () => {
    vi.stubEnv('LEADS_API_URL', '')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { calls } = setup()
    const response = await chat()
    expect(response.statusCode).toBe(200)
    expect(hosts(calls)).toEqual(['openrouter.ai', 'supabase.test'])
    expect(error).toHaveBeenCalledWith(
      '[chat function] Dual write: Worker save failed (user unaffected):',
      expect.stringContaining('LEADS_API_URL')
    )
  })

  it('when Supabase fails, the Worker is still written and the chat carries on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { calls } = setup({ supabase: () => textResponse(503) })
    const response = await chat()
    expect(response.statusCode).toBe(200)
    expect(hosts(calls)).toEqual(['openrouter.ai', 'supabase.test', 'leads-api.test'])
    expect(error).toHaveBeenCalledWith('[chat function] Lead trap door failed:', expect.stringContaining('503'))
  })
})

describe('chat.ts LEADS_BACKEND=worker', () => {
  beforeEach(() => {
    vi.stubEnv('LEADS_BACKEND', 'worker')
  })

  it('writes to the Worker only (no Supabase call)', async () => {
    const { calls } = setup()
    const response = await chat()
    expect(response.statusCode).toBe(200)
    expect(hosts(calls)).toEqual(['openrouter.ai', 'leads-api.test'])
    expect(calls[1].body).toEqual({ transcript: JSON.stringify(MESSAGES), source: 'steward-services' })
  })

  it('a Worker failure is logged like a Supabase failure was, and the chat carries on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ worker: () => jsonResponse(500, { error: 'internal_error' }) })
    const response = await chat()
    expect(response.statusCode).toBe(200)
    expect(error).toHaveBeenCalledWith('[chat function] Lead trap door failed:', expect.stringContaining('500'))
  })
})
