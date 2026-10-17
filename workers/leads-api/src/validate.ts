// Validation for POST /leads.
//
// The base rule mirrors the live Supabase anon INSERT policy on public.inbound_leads
// (read 2026-10-17):
//   name IS NOT NULL AND name <> '' AND email IS NOT NULL
//   AND email ~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$'
// plus the table constraint `source NOT NULL`, plus length limits.
//
// Note: like Postgres `name <> ''`, a whitespace-only name passes. That is deliberate:
// the Worker must accept exactly what the live policy accepts.

// Same pattern as the live policy; `~*` is case-insensitive, hence the `i` flag.
export const EMAIL_PATTERN = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/i

export const LIMITS = {
  name: 200,
  email: 254, // RFC 5321 maximum path length
  budget: 500,
  timeline: 500,
  transcript: 100_000,
  source: 100,
} as const

const ALLOWED_FIELDS = new Set(['name', 'email', 'budget', 'timeline', 'transcript', 'source'])

export interface LeadInput {
  name: string | null
  email: string | null
  budget: string | null
  timeline: string | null
  transcript: string | null
  source: string
}

export type ValidationResult =
  | { ok: true; lead: LeadInput }
  | { ok: false; errors: string[] }

export interface ValidationOptions {
  // When true, a lead with no name and no email is accepted if it carries a non-empty
  // transcript. This is the shape chat.ts writes today through the Supabase service role
  // (which bypasses the anon policy). Off by default; see README open question #1.
  allowTranscriptOnly: boolean
}

function optionalString(
  body: Record<string, unknown>,
  field: keyof typeof LIMITS,
  errors: string[]
): string | null {
  const value = body[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string or null`)
    return null
  }
  if (value.length > LIMITS[field]) {
    errors.push(`${field} must be at most ${LIMITS[field]} characters`)
  }
  return value
}

export function validateLead(body: unknown, options: ValidationOptions): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a JSON object'] }
  }

  const record = body as Record<string, unknown>
  const errors: string[] = []

  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) errors.push(`unknown field: ${key}`)
  }

  const name = optionalString(record, 'name', errors)
  const email = optionalString(record, 'email', errors)
  const budget = optionalString(record, 'budget', errors)
  const timeline = optionalString(record, 'timeline', errors)
  const transcript = optionalString(record, 'transcript', errors)
  const source = optionalString(record, 'source', errors)

  if (source === null || source === '') {
    errors.push('source is required')
  }

  const transcriptOnly =
    options.allowTranscriptOnly &&
    name === null &&
    email === null &&
    transcript !== null &&
    transcript.trim() !== ''

  if (!transcriptOnly) {
    if (name === null || name === '') {
      errors.push('name is required')
    }
    if (email === null) {
      errors.push('email is required')
    } else if (!EMAIL_PATTERN.test(email)) {
      errors.push('email is not a valid address')
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    lead: { name, email, budget, timeline, transcript, source: source as string },
  }
}
