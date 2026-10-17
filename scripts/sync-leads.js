// Downloads unread leads into leads/ (gitignored: real customer data) and marks them downloaded.
//
// Source follows LEADS_BACKEND (env or .env): `worker` reads the Cloudflare Worker
// (LEADS_API_URL + LEADS_API_SECRET); `supabase`, `dual` or unset read Supabase, which
// stays the source of truth until the switch to the Worker.
//
// Usage: node scripts/sync-leads.js
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER_PAGE_SIZE = 500

function parseDotEnv(content) {
  const vars = {}

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue

    const key = line.slice(0, eqIndex).trim()
    if (!key) continue

    let value = line.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    vars[key] = value
  }

  return vars
}

async function loadEnvFromDotFile(dotEnvPath) {
  try {
    const content = await fs.readFile(dotEnvPath, 'utf8')
    return parseDotEnv(content)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

function resolveSupabaseConfig(dotEnvVars) {
  const supabaseUrl = process.env.SUPABASE_URL || dotEnvVars.SUPABASE_URL
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || dotEnvVars.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in env or .env file.'
    )
  }

  return { supabaseUrl, serviceRoleKey }
}

export function resolveLeadsBackend(dotEnvVars) {
  const raw = process.env.LEADS_BACKEND || dotEnvVars.LEADS_BACKEND || ''
  const normalized = raw.trim().toLowerCase()
  if (normalized === '' || normalized === 'supabase') return 'supabase'
  if (normalized === 'dual' || normalized === 'worker') return normalized
  console.warn(`[sync-leads] Unknown LEADS_BACKEND "${raw}"; using "supabase"`)
  return 'supabase'
}

function resolveWorkerConfig(dotEnvVars) {
  const apiUrl = process.env.LEADS_API_URL || dotEnvVars.LEADS_API_URL
  const apiSecret = process.env.LEADS_API_SECRET || dotEnvVars.LEADS_API_SECRET

  if (!apiUrl || !apiSecret) {
    throw new Error('Missing LEADS_API_URL or LEADS_API_SECRET. Set them in env or .env file.')
  }

  return { apiUrl: apiUrl.replace(/\/+$/, ''), apiSecret }
}

function buildTimestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

async function fetchUnreadLeads(supabaseUrl, serviceRoleKey) {
  const url = `${supabaseUrl}/rest/v1/inbound_leads?downloaded=eq.false&order=created_at.asc`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to fetch unread leads (${response.status}): ${body}`)
  }

  return response.json()
}

async function markLeadsDownloaded(supabaseUrl, serviceRoleKey, ids) {
  if (!ids.length) return

  const idFilter = ids.join(',')
  const url = `${supabaseUrl}/rest/v1/inbound_leads?id=in.(${idFilter})`
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ downloaded: true }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to mark leads downloaded (${response.status}): ${body}`)
  }
}

export async function fetchUnreadLeadsFromWorker(apiUrl, apiSecret) {
  const leads = []
  let afterId = 0

  for (;;) {
    const url = `${apiUrl}/leads?downloaded=false&limit=${WORKER_PAGE_SIZE}&after_id=${afterId}`
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiSecret}`, Accept: 'application/json' },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to fetch unread leads from Worker (${response.status}): ${body}`)
    }

    const page = await response.json()
    leads.push(...page.leads)
    if (page.next_after_id === null || page.next_after_id === undefined) return leads
    afterId = page.next_after_id
  }
}

export async function markLeadsDownloadedInWorker(apiUrl, apiSecret, ids) {
  for (const id of ids) {
    const response = await fetch(`${apiUrl}/leads/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloaded: true }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to mark lead ${id} downloaded in Worker (${response.status}): ${body}`)
    }
  }
}

async function writeLeadsFile(leads) {
  const leadsDir = path.resolve('leads')
  await fs.mkdir(leadsDir, { recursive: true })

  const filename = `unread-leads-${buildTimestampSlug()}.json`
  const fullPath = path.join(leadsDir, filename)

  await fs.writeFile(fullPath, JSON.stringify(leads, null, 2), 'utf8')
  return fullPath
}

export async function main() {
  const dotEnvVars = await loadEnvFromDotFile(path.resolve('.env'))
  const backend = resolveLeadsBackend(dotEnvVars)

  let leads
  let markDownloaded
  let storeName

  if (backend === 'worker') {
    const { apiUrl, apiSecret } = resolveWorkerConfig(dotEnvVars)
    leads = await fetchUnreadLeadsFromWorker(apiUrl, apiSecret)
    markDownloaded = (ids) => markLeadsDownloadedInWorker(apiUrl, apiSecret, ids)
    storeName = 'the Worker'
  } else {
    const { supabaseUrl, serviceRoleKey } = resolveSupabaseConfig(dotEnvVars)
    leads = await fetchUnreadLeads(supabaseUrl, serviceRoleKey)
    markDownloaded = (ids) => markLeadsDownloaded(supabaseUrl, serviceRoleKey, ids)
    storeName = 'Supabase'
  }

  if (!Array.isArray(leads) || leads.length === 0) {
    console.log('No unread inbound leads found.')
    return
  }

  const outputPath = await writeLeadsFile(leads)
  const ids = leads.map((lead) => lead.id).filter((id) => typeof id === 'number')

  if (ids.length !== leads.length) {
    throw new Error('Some leads are missing numeric ids; refusing to mark rows as downloaded.')
  }

  await markDownloaded(ids)

  console.log(`Saved ${leads.length} unread lead(s) to ${outputPath}`)
  console.log(`Marked those lead(s) as downloaded in ${storeName}.`)
}

// Run only when executed directly (`node scripts/sync-leads.js`), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[sync-leads] Error:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
