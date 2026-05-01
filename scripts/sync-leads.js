import fs from 'node:fs/promises'
import path from 'node:path'

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

async function writeLeadsFile(leads) {
  const leadsDir = path.resolve('leads')
  await fs.mkdir(leadsDir, { recursive: true })

  const filename = `unread-leads-${buildTimestampSlug()}.json`
  const fullPath = path.join(leadsDir, filename)

  await fs.writeFile(fullPath, JSON.stringify(leads, null, 2), 'utf8')
  return fullPath
}

async function main() {
  const dotEnvVars = await loadEnvFromDotFile(path.resolve('.env'))
  const { supabaseUrl, serviceRoleKey } = resolveSupabaseConfig(dotEnvVars)

  const leads = await fetchUnreadLeads(supabaseUrl, serviceRoleKey)

  if (!Array.isArray(leads) || leads.length === 0) {
    console.log('No unread inbound leads found.')
    return
  }

  const outputPath = await writeLeadsFile(leads)
  const ids = leads.map((lead) => lead.id).filter((id) => typeof id === 'number')

  if (ids.length !== leads.length) {
    throw new Error('Some leads are missing numeric ids; refusing to mark rows as downloaded.')
  }

  await markLeadsDownloaded(supabaseUrl, serviceRoleKey, ids)

  console.log(`Saved ${leads.length} unread lead(s) to ${outputPath}`)
  console.log('Marked those lead(s) as downloaded in Supabase.')
}

main().catch((error) => {
  console.error('[sync-leads] Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
