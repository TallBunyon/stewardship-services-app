// services-leads-api: lead capture backend for services.stewardshipcomputellc.com.
//
// Routes (all require `Authorization: Bearer <LEADS_API_SECRET>`):
//   POST  /leads      insert a lead            -> 201 { id }
//   GET   /leads      list leads (admin)       -> 200 { leads, next_after_id }
//   PATCH /leads/:id  set `downloaded` (admin) -> 200 { lead }
//
// One route needs no secret:
//   GET | HEAD /health   liveness for uptime monitors -> 200 { "status": "ok" }
// It reads no data and returns nothing but that fixed body (no version, no environment), so it
// writes no audit_events row. It is a liveness check only: it does not touch D1 or the secret.
//
// Server-to-server only (called from Netlify functions and scripts/sync-leads.js).
// No CORS headers are sent, so browsers cannot call it cross-origin.
//
// Every response carries X-Request-Id. Each authenticated request on a /leads route and each
// request refused for its secret writes exactly one audit_events row (src/audit.ts), and each
// request writes one structured log line (src/log.ts).

import { appendAuditEvent, USER_AGENT_MAX_LENGTH, type AuditRow } from './audit'
import { errorMessage, logEvent } from './log'
import { validateLead } from './validate'

export const MAX_BODY_BYTES = 256 * 1024
export const PAUSED_RETRY_AFTER_SECONDS = 300
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

const AUTHENTICATED_ACTOR = 'shared-secret'
const ANONYMOUS_ACTOR = 'anonymous'

// The audit row a request will write. Handlers fill in result and target as they go; a
// handler that throws leaves result 'error'.
interface AuditDraft {
  actor: string
  action: string
  target: string | null
  result: string
  // Admin reads and writes return 500 instead of data when their row cannot be written.
  failClosed: boolean
}

interface RequestContext {
  requestId: string
  route: string
  audit: AuditDraft | null
}

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

type AuthOutcome = 'ok' | 'missing_secret' | 'wrong_secret'

async function authenticate(request: Request, secret: string): Promise<AuthOutcome> {
  const header = request.headers.get('Authorization') ?? ''
  const provided = /^Bearer\s+(.+)$/i.exec(header)?.[1].trim() ?? ''
  if (provided === '') return 'missing_secret'
  return (await secretsMatch(provided, secret)) ? 'ok' : 'wrong_secret'
}

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

// Only GET and HEAD are the health check. Any other method on /health stays what it was
// before the route existed: an unmatched path (404, no audit row).
function isHealthCheck(requestMethod: string, url: URL): boolean {
  return url.pathname === '/health' && (requestMethod === 'GET' || requestMethod === 'HEAD')
}

// Route template for logs and audit targets. Never the raw path or a custom method: both
// are caller-controlled and could carry anything.
function routeName(requestMethod: string, url: URL): string {
  const method = KNOWN_METHODS.has(requestMethod) ? requestMethod : 'OTHER'
  if (isHealthCheck(requestMethod, url)) return `${method} /health`
  if (url.pathname === '/leads') return `${method} /leads`
  if (/^\/leads\/[^/]+$/.test(url.pathname)) return `${method} /leads/:id`
  return `${method} (unmatched)`
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

async function createLead(request: Request, env: Env, audit: AuditDraft): Promise<Response> {
  if (env.LEADS_WRITE_PAUSED === 'true') {
    audit.result = 'rejected_paused'
    return json(
      503,
      { error: 'writes_paused' },
      { 'Retry-After': String(PAUSED_RETRY_AFTER_SECONDS) }
    )
  }

  const body = await readJsonBody(request)
  if (!body.ok) {
    audit.result = 'rejected_body'
    return body.response
  }

  const result = validateLead(body.value, {
    allowTranscriptOnly: env.LEADS_ALLOW_TRANSCRIPT_ONLY === 'true',
  })
  if (!result.ok) {
    audit.result = 'rejected_validation'
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

  audit.result = 'accepted'
  audit.target = `lead:${row.id}`
  return json(201, { id: row.id }, { Location: `/leads/${row.id}` })
}

function parseNonNegativeInt(value: string): number | null {
  if (!/^\d{1,15}$/.test(value)) return null
  return Number(value)
}

async function listLeads(url: URL, env: Env, audit: AuditDraft): Promise<Response> {
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

  if (errors.length > 0) {
    audit.result = 'rejected_validation'
    return json(400, { error: 'invalid_query', details: errors })
  }

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

  audit.result = 'ok'
  audit.target = `leads:[${leads.map((lead) => lead.id).join(',')}]`
  return json(200, { leads, next_after_id: nextAfterId })
}

async function updateLead(
  idParam: string,
  request: Request,
  env: Env,
  audit: AuditDraft
): Promise<Response> {
  const id = parseNonNegativeInt(idParam)
  if (id === null || id < 1) {
    audit.result = 'rejected_validation'
    return json(400, { error: 'invalid_id' })
  }
  audit.target = `lead:${id}`

  const body = await readJsonBody(request)
  if (!body.ok) {
    audit.result = 'rejected_body'
    return body.response
  }

  const value = body.value
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as Record<string, unknown>).downloaded !== 'boolean'
  ) {
    audit.result = 'rejected_validation'
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

  if (!row) {
    audit.result = 'not_found'
    return json(404, { error: 'not_found' })
  }
  audit.result = 'ok'
  return json(200, { lead: toApiLead(row) })
}

function authenticatedAudit(action: string, failClosed: boolean): AuditDraft {
  return { actor: AUTHENTICATED_ACTOR, action, target: null, result: 'error', failClosed }
}

async function route(request: Request, url: URL, env: Env, ctx: RequestContext): Promise<Response> {
  // Before the /leads match and before auth. ctx.audit stays null, so no audit row is written.
  if (isHealthCheck(request.method, url)) {
    const health = json(200, { status: 'ok' })
    return request.method === 'HEAD' ? new Response(null, { status: 200, headers: health.headers }) : health
  }

  const itemMatch = /^\/leads\/([^/]+)$/.exec(url.pathname)
  const isCollection = url.pathname === '/leads'

  if (!isCollection && !itemMatch) return json(404, { error: 'not_found' })

  if (!env.LEADS_API_SECRET) {
    logEvent('error', {
      event: 'server_misconfigured',
      request_id: ctx.requestId,
      route: ctx.route,
      detail: 'LEADS_API_SECRET is not configured; refusing all requests',
    })
    ctx.audit = {
      actor: ANONYMOUS_ACTOR,
      action: 'auth.refused',
      target: ctx.route,
      result: 'refused_server_misconfigured',
      failClosed: false,
    }
    return json(500, { error: 'server_misconfigured' })
  }

  const auth = await authenticate(request, env.LEADS_API_SECRET)
  if (auth !== 'ok') {
    ctx.audit = {
      actor: ANONYMOUS_ACTOR,
      action: 'auth.refused',
      target: ctx.route,
      result: `refused_${auth}`,
      failClosed: false,
    }
    return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
  }

  if (isCollection) {
    if (request.method === 'POST') {
      // Fail open: a lead the caller sent is never refused because auditing failed.
      ctx.audit = authenticatedAudit('lead.create', false)
      return createLead(request, env, ctx.audit)
    }
    if (request.method === 'GET') {
      ctx.audit = authenticatedAudit('lead.list', true)
      return listLeads(url, env, ctx.audit)
    }
  } else if (request.method === 'PATCH') {
    ctx.audit = authenticatedAudit('lead.update', true)
    return updateLead(itemMatch![1], request, env, ctx.audit)
  }

  ctx.audit = {
    ...authenticatedAudit('request.unsupported', false),
    target: ctx.route,
    result: 'rejected_method',
  }
  return json(405, { error: 'method_not_allowed' }, { Allow: isCollection ? 'GET, POST' : 'PATCH' })
}

async function writeAudit(
  request: Request,
  env: Env,
  draft: AuditDraft,
  ctx: RequestContext
): Promise<AuditRow> {
  return appendAuditEvent(env.DB, {
    ts: new Date().toISOString(),
    request_id: ctx.requestId,
    actor: draft.actor,
    action: draft.action,
    target: draft.target,
    result: draft.result,
    ip: request.headers.get('CF-Connecting-IP'),
    user_agent: request.headers.get('User-Agent')?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
  })
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const started = Date.now()
    const url = new URL(request.url)
    const ctx: RequestContext = {
      requestId: crypto.randomUUID(),
      route: routeName(request.method, url),
      audit: null,
    }

    let response: Response
    try {
      response = await route(request, url, env, ctx)
    } catch (err) {
      // Message only: never request bodies (they contain personal data).
      logEvent('error', {
        event: 'unhandled_error',
        request_id: ctx.requestId,
        route: ctx.route,
        error: errorMessage(err),
      })
      response = json(500, { error: 'internal_error' })
    }

    let auditRow: AuditRow | null = null
    if (ctx.audit) {
      try {
        auditRow = await writeAudit(request, env, ctx.audit, ctx)
      } catch (err) {
        logEvent('error', {
          event: 'audit_write_failed',
          request_id: ctx.requestId,
          route: ctx.route,
          action: ctx.audit.action,
          result: ctx.audit.result,
          error: errorMessage(err),
        })
        if (ctx.audit.failClosed) response = json(500, { error: 'audit_unavailable' })
      }
    }

    response.headers.set('X-Request-Id', ctx.requestId)
    logEvent('info', {
      event: 'request',
      request_id: ctx.requestId,
      route: ctx.route,
      status: response.status,
      duration_ms: Date.now() - started,
      audit_id: auditRow?.id ?? null,
      audit_hash: auditRow?.row_hash ?? null,
    })
    return response
  },
} satisfies ExportedHandler<Env>
