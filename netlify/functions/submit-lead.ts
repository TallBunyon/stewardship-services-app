import type { Handler, HandlerEvent } from '@netlify/functions'

interface LeadData {
  name?: string
  email?: string
  org: string
  service: string
  summary: string
  budget?: string
  timeline?: string
  transcript?: string
}

function formatTimestampCST(): string {
  return (
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }) + ' CST'
  )
}

async function persistLeadToSupabase(lead: LeadData): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured')
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/inbound_leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      created_at: new Date().toISOString(),
      name: lead.name ?? null,
      email: lead.email ?? null,
      budget: lead.budget ?? null,
      timeline: lead.timeline ?? null,
      transcript: lead.transcript ?? lead.summary ?? null,
      source: 'steward-services',
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Supabase insert returned ${response.status}: ${body}`)
  }
}


function buildFallbackBody(lead: LeadData, timestamp: string): string {
  return `🌱 New Lead — Stewardship Compute\n\nName: ${lead.name}\nEmail: ${lead.email}\nOrg: ${lead.org || 'N/A'}\nService: ${lead.service}\nSummary: ${lead.summary}\nTime: ${timestamp}\n\nReply APPROVE to begin outreach.`
}

async function sendEmailNotification(lead: LeadData, timestamp: string): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY
  const notifyEmail = process.env.NOTIFY_EMAIL || 'bobby.owen@stewardshipcomputellc.com'

  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured')
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: 'Steward <activate@stewardshipcomputellc.com>',
      to: notifyEmail,
      subject: `New Lead: ${lead.name} — ${lead.service}`,
      text: `New lead received at ${timestamp}\n\nName: ${lead.name}\nEmail: ${lead.email}\nOrg: ${lead.org || 'N/A'}\nService: ${lead.service}\nSummary: ${lead.summary}\nBudget: ${lead.budget || 'N/A'}\nTimeline: ${lead.timeline || 'N/A'}`,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Resend returned ${response.status}: ${body}`)
  }
}

async function sendTelegramFallbackNotification(lead: LeadData, timestamp: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured')
  }

  if (!chatId) {
    throw new Error('TELEGRAM_CHAT_ID is not configured')
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: buildFallbackBody(lead, timestamp),
      parse_mode: 'HTML',
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Telegram fallback returned ${response.status}: ${body}`)
  }
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  let lead: LeadData
  try {
    lead = JSON.parse(event.body ?? '{}') as LeadData
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' }
  }

  if (!lead.name || !lead.email || !lead.service) {
    return { statusCode: 400, body: 'Missing required lead fields: name, email, service' }
  }

  const timestamp = formatTimestampCST()
  let persistenceSucceeded = false
  let notificationSucceeded = false
  let notificationMessage = 'Resend notification failed'
  let fallbackMessage = 'Fallback Telegram notification failed'

  try {
    await persistLeadToSupabase(lead)
    persistenceSucceeded = true
  } catch (supabaseError) {
    console.error('[submit-lead] Supabase persistence error:', supabaseError)
  }

  try {
    await sendEmailNotification(lead, timestamp)
    notificationSucceeded = true
  } catch (notificationError) {
    console.error('[submit-lead] Resend notification error:', notificationError)
    notificationMessage =
      notificationError instanceof Error ? notificationError.message : 'Resend notification failed'

    try {
      await sendTelegramFallbackNotification(lead, timestamp)
      notificationSucceeded = true
    } catch (fallbackError) {
      fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : 'Fallback Telegram notification failed'
      console.error('[submit-lead] Telegram fallback error:', fallbackError)
    }
  }

  if (!persistenceSucceeded && !notificationSucceeded) {
    return {
      statusCode: 502,
      body: `Supabase persistence failed; ${notificationMessage}; Telegram fallback failed: ${fallbackMessage}`,
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  }
}