import { spawn } from 'node:child_process'
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

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL 
  ? `${process.env.OPENCLAW_GATEWAY_URL}/api/message`
  : 'http://127.0.0.1:18789/api/message'
const GOG_ACCOUNT = 'steward@stewardshipcomputellc.com'
const GOG_TO = 'bobby.owen@stewardshipcomputellc.com'

function buildGatewayMessage(lead: LeadData, timestamp: string): string {
  return `New lead received. Assess this and compose a professional email to bobby.owen@stewardshipcomputellc.com with your full analysis and recommendation.

Lead Data:
Name: ${lead.name}
Email: ${lead.email}
Organization: ${lead.org || 'N/A'}
Service Requested: ${lead.service}
Project Summary: ${lead.summary}
Time: ${timestamp}

Assess mission alignment, budget signal, recommended approach, and priority level. End your email with: "Reply APPROVE and I'll have Scribe draft the proposal within the hour."

After composing your assessment, send it via gog gmail send from steward@stewardshipcomputellc.com to bobby.owen@stewardshipcomputellc.com with subject: "New Lead: ${lead.name} — ${lead.service}"`
}

function buildFallbackBody(lead: LeadData, timestamp: string): string {
  return [
    'New Lead — Stewardship Compute Services (Direct Fallback)',
    '',
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Org: ${lead.org || 'N/A'}`,
    `Service: ${lead.service}`,
    `Summary: ${lead.summary}`,
    `Time: ${timestamp}`,
    '',
    'ACTION REQUIRED: OpenClaw gateway unavailable. Review and respond manually.',
  ].join('\n')
}

async function sendToOpenClaw(lead: LeadData, timestamp: string): Promise<void> {
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN

  if (!gatewayToken) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is not configured')
  }

  const response = await fetch(OPENCLAW_GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify({
      agent: 'steward',
      message: buildGatewayMessage(lead, timestamp),
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenClaw gateway returned ${response.status}: ${body}`)
  }
}

async function sendDirectFallbackEmail(lead: LeadData, timestamp: string): Promise<void> {
  const subject = `New Lead: ${lead.name} — ${lead.service}`
  const body = buildFallbackBody(lead, timestamp)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'gog',
      [
        'gmail',
        'send',
        '--account',
        GOG_ACCOUNT,
        '--to',
        GOG_TO,
        '--subject',
        subject,
        '--body-file',
        '-',
      ],
      {
        env: {
          ...process.env,
          GOGCLI_CONFIG_DIR: '/home/tallbunyon/.config/gogcli',
          GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD ?? '',
          GOG_ACCOUNT,
          PATH: '/usr/local/bin:/usr/bin:/bin',
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    )

    let stderr = ''

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(stderr.trim() || `gog gmail send exited with code ${code ?? 'unknown'}`))
    })

    child.stdin.end(body)
  })
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

  try {
    await sendToOpenClaw(lead, timestamp)

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    }
  } catch (gatewayError) {
    console.error('[submit-lead] OpenClaw gateway error:', gatewayError)
    const gatewayMessage =
      gatewayError instanceof Error ? gatewayError.message : 'OpenClaw gateway request failed'

    try {
      await sendDirectFallbackEmail(lead, timestamp)

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      }
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : 'Fallback email delivery failed'
      console.error('[submit-lead] fallback email error:', fallbackError)
      return { statusCode: 502, body: `${gatewayMessage}; fallback email failed: ${fallbackMessage}` }
    }
  }
}