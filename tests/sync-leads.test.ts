import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchUnreadLeadsFromWorker, main, markLeadsDownloadedInWorker } from '../scripts/sync-leads.js'
import { SUPABASE_KEY, SUPABASE_URL, WORKER_SECRET, WORKER_URL, hosts, jsonResponse, mockFetch, textResponse } from './helpers'

const workerLead = (id: number) => ({
  id,
  created_at: '2026-10-17T12:00:00.000Z',
  name: null,
  email: null,
  budget: null,
  timeline: null,
  transcript: '[]',
  source: 'steward-services',
  downloaded: false,
})

let originalCwd: string
let tmpDir: string

beforeEach(async () => {
  originalCwd = process.cwd()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-leads-test-'))
  process.chdir(tmpDir) // the script writes ./leads and reads ./.env
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('SUPABASE_URL', SUPABASE_URL)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_KEY)
  vi.stubEnv('LEADS_API_URL', WORKER_URL)
  vi.stubEnv('LEADS_API_SECRET', WORKER_SECRET)
  vi.stubEnv('LEADS_BACKEND', undefined)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writtenLeads(): Promise<unknown[]> {
  const files = await fs.readdir(path.join(tmpDir, 'leads'))
  expect(files).toHaveLength(1)
  return JSON.parse(await fs.readFile(path.join(tmpDir, 'leads', files[0]), 'utf8'))
}

describe('sync-leads Worker client', () => {
  it('fetchUnreadLeadsFromWorker follows next_after_id until it is null', async () => {
    const { calls } = mockFetch({
      [WORKER_URL]: (call) =>
        call.url.includes('after_id=0')
          ? jsonResponse(200, { leads: [workerLead(1), workerLead(2)], next_after_id: 2 })
          : jsonResponse(200, { leads: [workerLead(3)], next_after_id: null }),
    })

    const leads = await fetchUnreadLeadsFromWorker(WORKER_URL, WORKER_SECRET)
    expect(leads.map((lead: { id: number }) => lead.id)).toEqual([1, 2, 3])
    expect(calls.map((call) => call.url)).toEqual([
      `${WORKER_URL}/leads?downloaded=false&limit=500&after_id=0`,
      `${WORKER_URL}/leads?downloaded=false&limit=500&after_id=2`,
    ])
    expect(calls[0].headers.authorization).toBe(`Bearer ${WORKER_SECRET}`)
  })

  it('markLeadsDownloadedInWorker PATCHes each id', async () => {
    const { calls } = mockFetch({ [WORKER_URL]: () => jsonResponse(200, { lead: {} }) })
    await markLeadsDownloadedInWorker(WORKER_URL, WORKER_SECRET, [4, 5])
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['PATCH', `${WORKER_URL}/leads/4`, { downloaded: true }],
      ['PATCH', `${WORKER_URL}/leads/5`, { downloaded: true }],
    ])
  })

  it('markLeadsDownloadedInWorker throws on a failed PATCH', async () => {
    mockFetch({ [WORKER_URL]: () => jsonResponse(404, { error: 'not_found' }) })
    await expect(markLeadsDownloadedInWorker(WORKER_URL, WORKER_SECRET, [9])).rejects.toThrow(/lead 9.*404/)
  })
})

describe('sync-leads main()', () => {
  it('LEADS_BACKEND=worker: reads from the Worker, writes leads/, marks them downloaded; no Supabase call', async () => {
    vi.stubEnv('LEADS_BACKEND', 'worker')
    const { calls } = mockFetch({
      [WORKER_URL]: (call) =>
        call.method === 'GET'
          ? jsonResponse(200, { leads: [workerLead(1), workerLead(2)], next_after_id: null })
          : jsonResponse(200, { lead: {} }),
    })

    await main()

    expect(hosts(calls)).toEqual(['leads-api.test', 'leads-api.test', 'leads-api.test'])
    expect(calls.slice(1).map((call) => `${call.method} ${call.url}`)).toEqual([
      `PATCH ${WORKER_URL}/leads/1`,
      `PATCH ${WORKER_URL}/leads/2`,
    ])
    expect(await writtenLeads()).toEqual([workerLead(1), workerLead(2)])
  })

  it('LEADS_BACKEND=worker can come from ./.env', async () => {
    vi.stubEnv('LEADS_BACKEND', '')
    await fs.writeFile(path.join(tmpDir, '.env'), 'LEADS_BACKEND=worker\n')
    const { calls } = mockFetch({
      [WORKER_URL]: () => jsonResponse(200, { leads: [], next_after_id: null }),
    })
    await main()
    expect(hosts(calls)).toEqual(['leads-api.test'])
  })

  it.each([undefined, 'supabase', 'dual'])(
    'LEADS_BACKEND=%j: reads from Supabase as before; no Worker call',
    async (backend) => {
      vi.stubEnv('LEADS_BACKEND', backend)
      const supabaseRows = [{ id: 1, source: 'steward-services', downloaded: false }]
      const { calls } = mockFetch({
        [SUPABASE_URL]: (call) =>
          call.method === 'GET' ? jsonResponse(200, supabaseRows) : textResponse(204),
      })

      await main()

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        `GET ${SUPABASE_URL}/rest/v1/inbound_leads?downloaded=eq.false&order=created_at.asc`,
        `PATCH ${SUPABASE_URL}/rest/v1/inbound_leads?id=in.(1)`,
      ])
      expect(await writtenLeads()).toEqual(supabaseRows)
    }
  )

  it('LEADS_BACKEND=worker without Worker config fails before any request', async () => {
    vi.stubEnv('LEADS_BACKEND', 'worker')
    vi.stubEnv('LEADS_API_SECRET', '')
    const { fetchMock } = mockFetch({})
    await expect(main()).rejects.toThrow('Missing LEADS_API_URL or LEADS_API_SECRET')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
