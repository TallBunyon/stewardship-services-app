// SEC-K: structured logs. One JSON object per line, which Workers Logs (observability)
// indexes field by field.
//
// Fields are limited to primitives on purpose. Pass IDs, route names, status codes, counts
// and durations only: never request bodies, headers, lead fields, raw paths, queries or secrets.

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFields = { event: string } & Record<string, string | number | boolean | null>

export function logEvent(level: LogLevel, fields: LogFields): void {
  const line = JSON.stringify({ level, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

// Error messages from our own code and from D1 carry no bound values, but cap them anyway.
export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300)
}
