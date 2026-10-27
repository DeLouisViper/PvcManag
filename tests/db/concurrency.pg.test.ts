import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LocationInput } from '../../src/lib/engine'
import { createRealPgDb, REAL_PG_URL, type TestDb } from './harness'
import { U, balance, calcFor, expectIntegrity, matIds, payloadFor, seedUsers } from './suite'

// Real simultaneous connections: only meaningful on a real PostgreSQL server.
describe.skipIf(!REAL_PG_URL)('[postgres] concurrent stock consumption', () => {
  let db: TestDb
  let ids: Record<string, string>
  beforeAll(async () => {
    db = await createRealPgDb()
    await seedUsers(db)
    ids = await matIds(db)
    await db.rpc(U.admin, 'admin_record_opening_stock', {
      p_items: [
        { material_id: ids['PVC-D35'], kind: 'full', quantity: 8 },
        { material_id: ids['SCR-D35'], kind: 'screen', quantity: 1, length: 30 },
        { material_id: ids['CAP-D35'], kind: 'cap', quantity: 100 },
      ],
    })
  })
  afterAll(async () => db.close())

  it('10 users race for stock that only covers 2 jobs: exactly 2 succeed, 8 are refused, stock never negative', async () => {
    const locs: LocationInput[] = [{ type: 'piezometer', code: 'RACE', depthM: 12.5 }] // 4 new pipes each
    const c = await calcFor(db, U.alice, locs)
    const users = [U.alice, U.bob, U.carol, U.admin, U.admin2]
    const jobs = Array.from({ length: 10 }, (_, i) => db.rpc(users[i % 5], 'save_installation', { p: payloadFor(c.res, locs) }).catch((e) => ({ ok: false, error: String(e.message) })))
    const results = await Promise.all(jobs)
    const ok = results.filter((r: any) => r.ok === true)
    expect(ok).toHaveLength(2)
    expect(results.filter((r: any) => r.ok === false)).toHaveLength(8)
    expect(await balance(db, 'PVC-D35', 'full')).toBe(0)
    expect(await balance(db, 'SCR-D35', 'screen')).toBe(28)
    expect(await balance(db, 'CAP-D35', 'cap')).toBe(96)
    expect((await db.admin(`select count(*)::int n from public.installations`))[0].n).toBe(2)
    await expectIntegrity(db)
  })

  it('the same request id fired 8 times in parallel deducts once', async () => {
    await db.rpc(U.admin, 'admin_record_purchase', { p: { material_id: ids['PVC-D35'], quantity: 20 } })
    const locs: LocationInput[] = [{ type: 'piezometer', code: 'PAR', depthM: 3 }]
    const c = await calcFor(db, U.alice, locs)
    const p = payloadFor(c.res, locs, { client_request_id: randomUUID() })
    const before = await balance(db, 'PVC-D35', 'full')
    const results: any[] = await Promise.all(Array.from({ length: 8 }, () => db.rpc(U.alice, 'save_installation', { p })))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(new Set(results.map((r) => r.installation_id)).size).toBe(1)
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1)
    expect(await balance(db, 'PVC-D35', 'full')).toBe(before - c.res.pipePlans[0].newPipes)
    await expectIntegrity(db)
  })

  it('two users racing for the SAME offcut: one wins, the other gets a stale-plan answer', async () => {
    await db.rpc(U.admin, 'admin_record_opening_stock', { p_items: [{ material_id: ids['PVC-D35'], kind: 'offcut', quantity: 1, length: 3 }] })
    const mk = async (uid: string, code: string) => {
      const locs: LocationInput[] = [{ type: 'piezometer', code, depthM: 2, screenM: 0 }] // 3 m = the offcut
      const c = await calcFor(db, uid, locs)
      expect(c.res.steps[0].source).toBe('offcut')
      return payloadFor(c.res, locs)
    }
    const [pa, pb] = [await mk(U.alice, 'OA'), await mk(U.bob, 'OB')]
    const res: any[] = await Promise.all([db.rpc(U.alice, 'save_installation', { p: pa }), db.rpc(U.bob, 'save_installation', { p: pb })])
    expect(res.filter((r) => r.ok)).toHaveLength(1)
    expect(res.filter((r) => !r.ok)[0].error).toBe('STALE_PLAN')
    await expectIntegrity(db)
  })
})
