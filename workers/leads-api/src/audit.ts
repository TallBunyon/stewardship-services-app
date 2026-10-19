// SEC-A: append-only, hash-chained audit log (table audit_events, migration 0002).
//
// row_hash = hex SHA-256 of prev_hash, a newline, and the JSON array of the row's canonical
// fields (id, ts, request_id, actor, action, target, result, ip, user_agent). Altering,
// inserting or deleting any row before the head breaks the chain, and verifyChain() reports
// where. Dropping rows from the end cannot be seen from the table alone, so every request log
// line also carries audit_id and audit_hash: the log stream anchors the head.
//
// Rows hold IDs and outcome codes only. Callers must never pass lead content, names, emails,
// phone numbers or any secret.

export const GENESIS_HASH = '0'.repeat(64)
export const USER_AGENT_MAX_LENGTH = 256
const MAX_APPEND_ATTEMPTS = 8

export interface AuditEvent {
  ts: string
  request_id: string
  actor: string
  action: string
  target: string | null
  result: string
  ip: string | null
  user_agent: string | null
}

export interface AuditRow extends AuditEvent {
  id: number
  prev_hash: string
  row_hash: string
}

export type ChainVerification =
  | { ok: true; rows: number; head_id: number | null; head_hash: string }
  | { ok: false; rows_checked: number; broken_at_id: number; reason: string }

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function computeRowHash(row: Omit<AuditRow, 'row_hash'>): Promise<string> {
  const canonical = JSON.stringify([
    row.id,
    row.ts,
    row.request_id,
    row.actor,
    row.action,
    row.target,
    row.result,
    row.ip,
    row.user_agent,
  ])
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${row.prev_hash}\n${canonical}`)
  )
  return toHex(digest)
}

// Two appends that read the same head both try to claim its id + 1 and its hash as
// prev_hash; the database lets only one of them in.
function isChainConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed: audit_events\.(id|prev_hash|row_hash)/.test(message)
}

export async function appendAuditEvent(db: D1Database, event: AuditEvent): Promise<AuditRow> {
  for (let attempt = 1; ; attempt++) {
    const head = await db
      .prepare('SELECT id, row_hash FROM audit_events ORDER BY id DESC LIMIT 1')
      .first<{ id: number; row_hash: string }>()

    const unsealed = {
      ...event,
      id: (head?.id ?? 0) + 1,
      prev_hash: head?.row_hash ?? GENESIS_HASH,
    }
    const row: AuditRow = { ...unsealed, row_hash: await computeRowHash(unsealed) }

    try {
      await db
        .prepare(
          `INSERT INTO audit_events
             (id, ts, request_id, actor, action, target, result, ip, user_agent, prev_hash, row_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.id,
          row.ts,
          row.request_id,
          row.actor,
          row.action,
          row.target,
          row.result,
          row.ip,
          row.user_agent,
          row.prev_hash,
          row.row_hash
        )
        .run()
      return row
    } catch (err) {
      if (attempt >= MAX_APPEND_ATTEMPTS || !isChainConflict(err)) throw err
      // Jittered backoff so concurrent appends stop colliding on the same head.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5 * attempt))
    }
  }
}

// Walks the whole table in id order and checks that ids are gap-free from 1, that each
// prev_hash equals the previous row_hash, and that each row_hash matches the row's contents.
export async function verifyChain(db: D1Database, pageSize = 500): Promise<ChainVerification> {
  let expectedId = 1
  let expectedPrev = GENESIS_HASH

  for (;;) {
    const { results } = await db
      .prepare('SELECT * FROM audit_events WHERE id >= ? ORDER BY id ASC LIMIT ?')
      .bind(expectedId, pageSize)
      .all<AuditRow>()

    for (const row of results) {
      const broken = (reason: string): ChainVerification => ({
        ok: false,
        rows_checked: expectedId - 1,
        broken_at_id: row.id,
        reason,
      })
      if (row.id !== expectedId) return broken(`expected id ${expectedId}`)
      if (row.prev_hash !== expectedPrev) {
        return broken('prev_hash does not match the previous row_hash')
      }
      if ((await computeRowHash(row)) !== row.row_hash) {
        return broken('row_hash does not match the row contents')
      }
      expectedPrev = row.row_hash
      expectedId++
    }

    if (results.length < pageSize) {
      const rows = expectedId - 1
      return { ok: true, rows, head_id: rows === 0 ? null : rows, head_hash: expectedPrev }
    }
  }
}
