import { describe } from 'vitest'
import { createRealPgDb, REAL_PG_URL } from './harness'
import { registerSuite } from './suite'

// Runs the identical suite against a real PostgreSQL server when TEST_DATABASE_URL is provided.
if (REAL_PG_URL) registerSuite('postgres', createRealPgDb)
else describe.skip('[postgres] set TEST_DATABASE_URL to run the suite on a real server', () => {})
