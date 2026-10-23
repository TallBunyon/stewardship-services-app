import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Storage is isolated per test file, so this runs once for each file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
