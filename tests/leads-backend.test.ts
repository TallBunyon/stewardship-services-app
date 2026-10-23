import { describe, expect, it, vi } from 'vitest'
import { persistLead, resolveLeadsBackend, saveLeadToWorker } from '../netlify/lib/leads-backend'
import { WORKER_SECRET, WORKER_URL, jsonResponse, mockFetch } from './helpers'

describe('resolveLeadsBackend', () => {
  it.each([
    [undefined, 'supabase'],
    ['', 'supabase'],
    ['supabase', 'supabase'],
    ['dual', 'dual'],
    [' Dual ', 'dual'],
    ['worker', 'worker'],
    ['WORKER', 'worker'],
  ])('%j -> %s', (value, expected) => {
    expect(resolveLeadsBackend(value)).toBe(expected)
  })

  it('unknown values fall back to supabase with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveLeadsBackend('cloudflare')).toBe('supabase')
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('saveLeadToWorker', () => {
  const lead = { transcript: '[]', source: 'steward-services' }

  it('POSTs to <url>/leads with the bearer secret and returns the id', async () => {
    const { calls } = mockFetch({ [WORKER_URL]: () => jsonResponse(201, { id: 12 }) })
    await expect(saveLeadToWorker(lead, { url: `${WORKER_URL}/`, secret: WORKER_SECRET })).resolves.toBe(12)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: `${WORKER_URL}/leads`,
      method: 'POST',
      headers: { authorization: `Bearer ${WORKER_SECRET}`, 'content-type': 'application/json' },
      body: lead,
    })
  })

  it('throws on a non-2xx response, including the status', async () => {
    mockFetch({ [WORKER_URL]: () => jsonResponse(401, { error: 'unauthorized' }) })
    await expect(saveLeadToWorker(lead, { url: WORKER_URL, secret: 'wrong' })).rejects.toThrow(
      /Worker lead save failed: 401/
    )
  })

  it('throws without calling fetch when config is missing', async () => {
    const { fetchMock } = mockFetch({})
    await expect(saveLeadToWorker(lead, { url: undefined, secret: WORKER_SECRET })).rejects.toThrow(
      'LEADS_API_URL or LEADS_API_SECRET is not configured'
    )
    await expect(saveLeadToWorker(lead, { url: WORKER_URL, secret: '' })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('persistLead', () => {
  function recorder(failures: { supabase?: boolean; worker?: boolean } = {}) {
    const order: string[] = []
    return {
      order,
      saveToSupabase: async () => {
        order.push('supabase')
        if (failures.supabase) throw new Error('supabase down')
      },
      saveToWorker: async () => {
        order.push('worker')
        if (failures.worker) throw new Error('worker down')
      },
    }
  }

  it('supabase: only Supabase', async () => {
    const r = recorder()
    await persistLead({ backend: 'supabase', ...r, logPrefix: '[t]' })
    expect(r.order).toEqual(['supabase'])
  })

  it('worker: only the Worker, and its error propagates', async () => {
    const r = recorder({ worker: true })
    await expect(persistLead({ backend: 'worker', ...r, logPrefix: '[t]' })).rejects.toThrow('worker down')
    expect(r.order).toEqual(['worker'])
  })

  it('dual: Supabase then Worker; a Worker error is swallowed and logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = recorder({ worker: true })
    await expect(persistLead({ backend: 'dual', ...r, logPrefix: '[t]' })).resolves.toBeUndefined()
    expect(r.order).toEqual(['supabase', 'worker'])
    expect(error).toHaveBeenCalledWith('[t] Dual write: Worker save failed (user unaffected):', 'worker down')
  })

  it('dual: a Supabase error still propagates, after the Worker write is attempted', async () => {
    const r = recorder({ supabase: true })
    await expect(persistLead({ backend: 'dual', ...r, logPrefix: '[t]' })).rejects.toThrow('supabase down')
    expect(r.order).toEqual(['supabase', 'worker'])
  })
})
