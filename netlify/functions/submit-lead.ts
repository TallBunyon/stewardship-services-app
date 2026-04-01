import type { Handler, HandlerEvent } from '@netlify/functions'

interface LeadData {
  name: string
  email: string
  org: string
  service: string
  summary: string
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

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL
  if (!webhookUrl) {
    return { statusCode: 500, body: 'DISCORD_WEBHOOK_URL is not configured' }
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
  const content = [
    '🌱 New Lead — Stewardship Compute Services',
    '',
    `**Name:** ${lead.name}`,
    `**Email:** ${lead.email}`,
    `**Org:** ${lead.org || 'N/A'}`,
    `**Service:** ${lead.service}`,
    `**Summary:** ${lead.summary}`,
    `**Time:** ${timestamp}`,
  ].join('\n')

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error('[submit-lead] Discord webhook error:', res.status, body)
      return { statusCode: 502, body: `Discord webhook returned ${res.status}` }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Webhook request failed'
    console.error('[submit-lead]', message)
    return { statusCode: 502, body: message }
  }
}
