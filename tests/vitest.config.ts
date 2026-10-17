import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    // `forks` (the default) is required: the sync-leads tests use process.chdir().
    pool: 'forks',
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
})
