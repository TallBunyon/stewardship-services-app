// LEADS_BACKEND switch shared by the Netlify functions that persist leads.
//
//   supabase (default, also when unset or unknown): write to Supabase only, exactly as before.
//   dual:   write to Supabase first (its outcome is what the caller sees, as before),
//           then to the Cloudflare Worker. A Worker failure is logged and never
//           surfaces to the user.
//   worker: write to the Worker only. Its failure is the caller's persistence failure.
//
// Worker env: LEADS_API_URL (e.g. https://<worker>.<account>.workers.dev) and LEADS_API_SECRET.
//
// Lives outside netlify/functions/ so Netlify does not deploy it as a function;
// esbuild bundles it into each function that imports it.

export type LeadsBackend = 'supabase' | 'dual' | 'worker'

export interface WorkerLead {
  name?: string | null
  email?: string | null
  budget?: string | null
  timeline?: string | null
  transcript?: string | null
  source: string
}

export interface WorkerConfig {
  url: string | undefined
  secret: string | undefined
}

export const WORKER_TIMEOUT_MS = 5000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function resolveLeadsBackend(value: string | undefined): LeadsBackend {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === '' || normalized === 'supabase') return 'supabase'
  if (normalized === 'dual' || normalized === 'worker') return normalized
  console.warn(`[leads-backend] Unknown LEADS_BACKEND "${value}"; using "supabase"`)
  return 'supabase'
}

export async function saveLeadToWorker(lead: WorkerLead, config: WorkerConfig): Promise<number> {
  if (!config.url || !config.secret) {
    throw new Error('LEADS_API_URL or LEADS_API_SECRET is not configured')
  }

  const response = await fetch(`${config.url.replace(/\/+$/, '')}/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.secret}`,
    },
    body: JSON.stringify(lead),
    signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
  })

  if (!response.ok) {
    // The Worker never echoes lead data back, so its error body is safe to log.
    const body = await response.text().catch(() => '')
    throw new Error(`Worker lead save failed: ${response.status} ${body}`.trim())
  }

  const data = (await response.json()) as { id: number }
  return data.id
}

export async function persistLead(options: {
  backend: LeadsBackend
  saveToSupabase: () => Promise<void>
  saveToWorker: () => Promise<unknown>
  logPrefix: string
}): Promise<void> {
  const { backend, saveToSupabase, saveToWorker, logPrefix } = options

  if (backend === 'supabase') {
    await saveToSupabase()
    return
  }

  if (backend === 'worker') {
    await saveToWorker()
    return
  }

  // dual: Supabase first, exactly as before. The Worker write is still attempted when
  // Supabase fails, so the lead is captured somewhere, but only Supabase's result is
  // reported to the caller.
  let supabaseFailed = false
  let supabaseError: unknown
  try {
    await saveToSupabase()
  } catch (err) {
    supabaseFailed = true
    supabaseError = err
  }

  try {
    await saveToWorker()
  } catch (err) {
    console.error(`${logPrefix} Dual write: Worker save failed (user unaffected):`, errorMessage(err))
  }

  if (supabaseFailed) throw supabaseError
}
