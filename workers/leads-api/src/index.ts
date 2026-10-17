// services-leads-api: lead capture backend for services.stewardshipcomputellc.com.
//
// Routes (all require `Authorization: Bearer <LEADS_API_SECRET>`):
//   POST  /leads      insert a lead            -> 201 { id }
//   GET   /leads      list leads (admin)       -> 200 { leads, next_after_id }
//   PATCH /leads/:id  set `downloaded` (admin) -> 200 { lead }
//
// Server-to-server only (called from Netlify functions and scripts/sync-leads.js).
// No CORS headers are sent, so browsers cannot call it cross-origin.

import { validateLead } from './validate'

export const MAX_BODY_BYTES = 256 * 1024
export const PAUSED_RETRY_AFTER_SECONDS = 300
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

interface LeadRow {
  id: number
  created_at: string
  name: string | null
  email: string | null
  budget: string | null
  timeline: string | null
  transcript: string | null
  source: string
  downloaded: number
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

function toApiLead(row: LeadRow) {
  return { ...row, downloaded: row.downloaded === 1 }
}

// Constant-time comparison: hash both values to a fixed size first so neither the
// content nor the length of the secret leaks through timing.
async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  return crypto.subtle.timingSafeEqual(a, b)
}

async function isAuthorized(request: Request, secret: string): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false
  return secretsMatch(match[1].trim(), secret)
}

async function readJsonBody(
  request: Request
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers.get('Content-Type') ?? ''
  if (!/^application\/json\b/i.test(contentType)) {
    return { ok: false, response: json(415, { error: 'content_type_must_be_application_json' }) }
  }

  const declaredLength = Number(request.headers.get('Content-Length') ?? '0')
  if (declaredLength > MAX_BODY_BYTES) {
    return { ok: false, response: json(413, { error: 'body_too_large', max_bytes: MAX_BODY_BYTES }) }
  }

  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: json(413, { error: 'body_too_large', max_bytes: MAX_BODY_BYTES }) }
  }

  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, response: json(400, { error: 'invalid_json' }) }
  }
}

async function createLead(request: Request, env: Env): Promise<Response> {
  if (env.LEADS_WRITE_PAUSED === 'true') {
    return json(
      503,
      { error: 'writes_paused' },
      { 'Retry-After': String(PAUSED_RETRY_AFTER_SECONDS) }
    )
  }

  const body = await readJsonBody(request)
  if (!body.ok) return body.response

  const result = validateLead(body.value, {
    allowTranscriptOnly: env.LEADS_ALLOW_TRANSCRIPT_ONLY === 'true',
  })
  if (!result.ok) {
    return json(400, { error: 'validation_failed', details: result.errors })
  }

  const { lead } = result
  const row = await env.DB.prepare(
    `INSERT INTO inbound_leads (created_at, name, email, budget, timeline, transcript, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  )
    .bind(
      new Date().toISOString(),
      lead.name,
      lead.email,
      lead.budget,
      lead.timeline,
      lead.transcript,
      lead.source
    )
    .first<{ id: number }>()

  if (!row) throw new Error('insert returned no row')

  return json(201, { id: row.id }, { Location: `/leads/${row.id}` })
}

function parseNonNegativeInt(value: string): number | null {
  if (!/^\d{1,15}$/.test(value)) return null
  return Number(value)
}

async function listLeads(url: URL, env: Env): Promise<Response> {
  const params = url.searchParams
  const errors: string[] = []

  let downloaded: number | null = null
  const downloadedParam = params.get('downloaded')
  if (downloadedParam !== null) {
    if (downloadedParam === 'true') downloaded = 1
    else if (downloadedParam === 'false') downloaded = 0
    else errors.push('downloaded must be "true" or "false"')
  }

  let limit = DEFAULT_LIST_LIMIT
  const limitParam = params.get('limit')
  if (limitParam !== null) {
    const parsed = parseNonNegativeInt(limitParam)
    if (parsed === null || parsed < 1 || parsed > MAX_LIST_LIMIT) {
      errors.push(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`)
    } else {
      limit = parsed
    }
  }

  let afterId = 0
  const afterIdParam = params.get('after_id')
  if (afterIdParam !== null) {
    const parsed = parseNonNegativeInt(afterIdParam)
    if (parsed === null) errors.push('after_id must be a non-negative integer')
    else afterId = parsed
  }

  if (errors.length > 0) return json(400, { error: 'invalid_query', details: errors })

  const statement =
    downloaded === null
      ? env.DB.prepare(
          'SELECT * FROM inbound_leads WHERE id > ? ORDER BY id ASC LIMIT ?'
        ).bind(afterId, limit)
      : env.DB.prepare(
          'SELECT * FROM inbound_leads WHERE id > ? AND downloaded = ? ORDER BY id ASC LIMIT ?'
        ).bind(afterId, downloaded, limit)

  const { results } = await statement.all<LeadRow>()
  const leads = results.map(toApiLead)
  const nextAfterId = leads.length === limit ? leads[leads.length - 1].id : null

  return json(200, { leads, next_after_id: nextAfterId })
}

async function updateLead(idParam: string, request: Request, env: Env): Promise<Response> {
  const id = parseNonNegativeInt(idParam)
  if (id === null || id < 1) return json(400, { error: 'invalid_id' })

  const body = await readJsonBody(request)
  if (!body.ok) return body.response

  const value = body.value
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as Record<string, unknown>).downloaded !== 'boolean'
  ) {
    return json(400, {
      error: 'validation_failed',
      details: ['body must be exactly { "downloaded": true | false }'],
    })
  }

  const downloaded = (value as { downloaded: boolean }).downloaded ? 1 : 0
  const row = await env.DB.prepare(
    'UPDATE inbound_leads SET downloaded = ? WHERE id = ? RETURNING *'
  )
    .bind(downloaded, id)
    .first<LeadRow>()

  if (!row) return json(404, { error: 'not_found' })
  return json(200, { lead: toApiLead(row) })
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const itemMatch = /^\/leads\/([^/]+)$/.exec(url.pathname)
  const isCollection = url.pathname === '/leads'

  if (!isCollection && !itemMatch) return json(404, { error: 'not_found' })

  if (!env.LEADS_API_SECRET) {
    console.error('[leads-api] LEADS_API_SECRET is not configured; refusing all requests')
    return json(500, { error: 'server_misconfigured' })
  }

  if (!(await isAuthorized(request, env.LEADS_API_SECRET))) {
    return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
  }

  if (isCollection) {
    if (request.method === 'POST') return createLead(request, env)
    if (request.method === 'GET') return listLeads(url, env)
    return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' })
  }

  if (request.method === 'PATCH') return updateLead(itemMatch![1], request, env)
  return json(405, { error: 'method_not_allowed' }, { Allow: 'PATCH' })
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    try {
      return await route(request, env)
    } catch (err) {
      // Log the message only: never request bodies (they contain personal data).
      console.error('[leads-api] unhandled error:', err instanceof Error ? err.message : String(err))
      return json(500, { error: 'internal_error' })
    }
  },
} satisfies ExportedHandler<Env>
