import type { HandlerContext, HandlerEvent, HandlerResponse } from '@netlify/functions'
import { vi } from 'vitest'

// Placeholder endpoints and credentials only. Nothing here is real.
export const SUPABASE_URL = 'https://supabase.test'
export const SUPABASE_KEY = 'test-service-role-placeholder'
export const WORKER_URL = 'https://leads-api.test'
export const WORKER_SECRET = 'test-leads-api-placeholder'

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal | null | undefined
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>

// Replaces global fetch. Routes by URL prefix; unknown URLs fail the test loudly.
export function mockFetch(routes: Record<string, Responder>) {
  const calls: RecordedCall[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const rawBody = init.body
    let body: unknown = rawBody
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
    }
    const call: RecordedCall = {
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body,
      signal: init.signal,
    }
    calls.push(call)
    const prefix = Object.keys(routes).find((key) => url.startsWith(key))
    if (!prefix) throw new Error(`Unexpected fetch to ${url}`)
    return routes[prefix](call)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function textResponse(status: number, body = ''): Response {
  // A null-body status (204/205/304) cannot carry a body, even an empty string.
  return new Response([204, 205, 304].includes(status) ? null : body, { status })
}

export function postEvent(body: unknown): HandlerEvent {
  return {
    httpMethod: 'POST',
    body: JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    rawUrl: 'https://services.test/.netlify/functions/x',
    rawQuery: '',
    path: '/.netlify/functions/x',
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
  }
}

export async function invoke(
  handler: (event: HandlerEvent, context: HandlerContext) => unknown,
  event: HandlerEvent
): Promise<HandlerResponse> {
  return (await handler(event, {} as HandlerContext)) as HandlerResponse
}

export function hosts(calls: RecordedCall[]): string[] {
  return calls.map((call) => new URL(call.url).host)
}
