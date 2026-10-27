import { createPgliteDb } from './harness'
import { registerSuite } from './suite'

registerSuite('pglite', createPgliteDb)
