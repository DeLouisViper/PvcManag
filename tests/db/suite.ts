import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { calculate, toRpcPlan, type CalculationResult, type LocationInput } from '../../src/lib/engine'
import { buildEngineConfig, buildInventoryInput, settingsMap } from '../../src/lib/inventoryModel'
import { num, type Row, type TestDb } from './harness'

export const U = {
  admin: '00000000-0000-4000-8000-000000000001',
  admin2: '00000000-0000-4000-8000-000000000002',
  alice: '00000000-0000-4000-8000-0000000000a1',
  bob: '00000000-0000-4000-8000-0000000000b2',
  carol: '00000000-0000-4000-8000-0000000000c3',
}

export async function seedUsers(db: TestDb) {
  await db.admin(
    `insert into auth.users (id, email, raw_user_meta_data) values
      ($1,'admin@haic.test','{"full_name":"Admin One"}'), ($2,'admin2@haic.test','{"full_name":"Admin Two"}'),
      ($3,'alice@haic.test','{"full_name":"Alice"}'), ($4,'bob@haic.test','{"full_name":"Bob"}'), ($5,'carol@haic.test','{"full_name":"Carol"}')`,
    [U.admin, U.admin2, U.alice, U.bob, U.carol],
  )
  await db.admin(`update public.profiles set active = true where id in ($1, $2, $3, $4, $5)`, [U.admin, U.admin2, U.alice, U.bob, U.carol])
  await db.admin(`update public.profiles set role = 'admin' where id in ($1, $2)`, [U.admin, U.admin2])
}

export async function matIds(db: TestDb): Promise<Record<string, string>> {
  const rows = await db.admin('select id, sku from public.materials')
  return Object.fromEntries(rows.map((r) => [r.sku as string, r.id as string]))
}

/** Standard opening stock used by most scenarios. */
export async function seedStock(db: TestDb, ids: Record<string, string>, over: Partial<Record<string, number>> = {}) {
  const q = (k: string, d: number) => over[k] ?? d
  const items = [
    { material_id: ids['PVC-D35'], kind: 'full', quantity: q('d35', 20) },
    { material_id: ids['PVC-D35'], kind: 'offcut', quantity: 1, length: 2.5 },
    { material_id: ids['PVC-D35'], kind: 'offcut', quantity: 2, length: 1 },
    { material_id: ids['PVC-D55'], kind: 'full', quantity: q('d55', 10) },
    { material_id: ids['PVC-D90'], kind: 'full', quantity: q('d90', 12) },
    { material_id: ids['SCR-D35'], kind: 'screen', quantity: 3, length: 10 },
    { material_id: ids['SCR-D55'], kind: 'screen', quantity: 4, length: 10 },
    { material_id: ids['CAP-D35'], kind: 'cap', quantity: q('c35', 20) },
    { material_id: ids['CAP-D55'], kind: 'cap', quantity: q('c55', 10) },
    { material_id: ids['CAP-D90'], kind: 'cap', quantity: q('c90', 10) },
  ].filter((i) => i.quantity > 0)
  return db.rpc(U.admin, 'admin_record_opening_stock', { p_items: items, p_notes: 'Opening stock for tests' })
}

/** Reads exactly what the web app reads (as the user, through RLS) and runs the shared engine. */
export async function calcFor(db: TestDb, uid: string, locs: LocationInput[]) {
  const materials = (await db.as(uid, 'select * from public.materials order by sort_order')) as any[]
  const itypes = (await db.as(uid, 'select * from public.installation_types')) as any[]
  const settings = (await db.as(uid, 'select key, value from public.material_settings')) as any[]
  const balances = (await db.as(uid, 'select * from public.inventory_balances')) as any[]
  const offcuts = (await db.as(uid, `select * from public.pipe_offcuts where status = 'available'`)) as any[]
  const cfg = buildEngineConfig(itypes, settingsMap(settings as any))
  const inv = buildInventoryInput(materials, balances, offcuts)
  const res = calculate(locs, cfg, inv)
  return { cfg, inv, res, materials }
}

export function payloadFor(res: CalculationResult, locs: LocationInput[], extra: Record<string, unknown> = {}) {
  return {
    client_request_id: randomUUID(),
    project_name: 'Test project',
    install_date: '2026-10-24',
    notes: null,
    locations: locs.map((l) => ({
      type: l.type,
      code: l.code,
      depth: Number(l.depthM),
      screen_length: l.screenM === undefined || l.screenM === null || l.screenM === '' ? null : Number(l.screenM),
    })),
    plan: toRpcPlan(res),
    ...extra,
  }
}

export async function save(db: TestDb, uid: string, locs: LocationInput[], extra: Record<string, unknown> = {}) {
  const c = await calcFor(db, uid, locs)
  if (!c.res.ok) throw new Error('calc failed: ' + JSON.stringify(c.res.issues))
  const out = await db.rpc(uid, 'save_installation', { p: payloadFor(c.res, locs, extra) })
  return { out, ...c }
}

export async function snapshot(db: TestDb) {
  const [bal, off, inst, led, loc, plan, use, aud] = await Promise.all([
    db.admin(`select material_id, bucket, quantity::text q from public.inventory_balances order by 1, 2`),
    db.admin(`select id, status from public.pipe_offcuts order by id`),
    db.admin(`select count(*)::int n from public.installations`),
    db.admin(`select count(*)::int n from public.inventory_transactions`),
    db.admin(`select count(*)::int n from public.installation_locations`),
    db.admin(`select count(*)::int n from public.installation_cutting_plans`),
    db.admin(`select count(*)::int n from public.installation_material_usage`),
    db.admin(`select count(*)::int n from public.audit_logs`),
  ])
  return JSON.stringify([bal, off, inst, led, loc, plan, use, aud])
}

export async function balance(db: TestDb, sku: string, bucket: string): Promise<number> {
  const r = await db.admin(
    `select b.quantity from public.inventory_balances b join public.materials m on m.id = b.material_id where m.sku = $1 and b.bucket = $2`,
    [sku, bucket],
  )
  return num(r[0].quantity)
}

export async function expectIntegrity(db: TestDb) {
  const rows = await db.rpc(U.admin, 'verify_inventory_integrity')
  void rows
  const r = await db.as(U.admin, 'select * from public.verify_inventory_integrity()')
  expect(r.length).toBeGreaterThan(0)
  for (const row of r) expect(row.ok, `integrity ${row.sku}/${row.bucket}: balance ${row.balance} ledger ${row.ledger_sum}`).toBe(true)
}

export async function rejects(p: Promise<unknown>, re: RegExp) {
  let err: unknown = null
  try {
    await p
  } catch (e) {
    err = e
  }
  expect(err, 'expected the call to be rejected').not.toBeNull()
  expect(String((err as Error).message)).toMatch(re)
}

const P = (code: string, depthM: number | string, screenM?: number | string): LocationInput => ({
  type: 'piezometer',
  code,
  depthM,
  screenM: screenM ?? null,
})

export function registerSuite(label: string, makeDb: () => Promise<TestDb>) {
  // ============================================================== SECURITY
  describe(`[${label}] security, privileges and RLS`, () => {
    let db: TestDb
    let ids: Record<string, string>
    beforeAll(async () => {
      db = await makeDb()
      await seedUsers(db)
      ids = await matIds(db)
      await seedStock(db, ids)
    })
    afterAll(async () => db.close())

    it('self-signup can never produce an admin: trigger ignores user-editable metadata', async () => {
      await db.admin(`insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), 'evil@x.test', '{"role":"admin","full_name":"Evil"}')`)
      const r = await db.admin(`select role, active from public.profiles where email = 'evil@x.test'`)
      expect(r[0].role).toBe('user')
      expect(r[0].active).toBe(false) // new accounts start inactive: they can see nothing until an admin activates them
      const evil = (await db.admin(`select id from public.profiles where email = 'evil@x.test'`))[0].id
      expect(await db.as(evil, 'select * from public.materials')).toHaveLength(0)
      await rejects(db.rpc(evil, 'save_installation', { p: { client_request_id: randomUUID(), locations: [] } }), /FORBIDDEN/)
    })

    it('anonymous visitors can read nothing and call nothing', async () => {
      for (const t of ['materials', 'inventory_balances', 'profiles', 'installations', 'inventory_transactions', 'material_settings']) {
        await rejects(db.anon(`select * from public.${t}`), /permission denied/)
      }
      await rejects(db.anon(`select public.save_installation('{}'::jsonb)`), /permission denied/)
      await rejects(db.anon(`select * from public.get_inventory_overview()`), /permission denied/)
    })

    it('signed-in users cannot write ANY table directly (stock, ledger, offcuts, settings, profiles ...)', async () => {
      const m = ids['PVC-D35']
      const attempts = [
        `update public.inventory_balances set quantity = 9999 where material_id = '${m}'`,
        `insert into public.inventory_balances (material_id, bucket, quantity) values ('${m}', 'cap', 5)`,
        `delete from public.inventory_balances`,
        `insert into public.inventory_transactions (tx_ref, group_ref, material_id, bucket, tx_type, quantity, unit, balance_before, balance_after, user_id) values ('x','x','${m}','full','adjustment',1,'pcs',0,1,'${U.alice}')`,
        `insert into public.pipe_offcuts (material_id, length, origin) values ('${m}', 3.9, 'adjustment')`,
        `update public.pipe_offcuts set status = 'available'`,
        `update public.materials set low_stock_threshold = 0`,
        `update public.material_settings set value = '99'::jsonb where key = 'pipe_stock_length'`,
        `update public.profiles set role = 'admin' where id = '${U.alice}'`,
        `update public.profiles set active = true`,
        `insert into public.installations (ref, client_request_id, install_date, transaction_ref, location_count, total_depth, settings_snapshot, calculation, created_by) values ('x', gen_random_uuid(), now(), 'x', 1, 1, '{}', '{}', '${U.alice}')`,
        `insert into public.purchases (ref, purchase_date, material_id, quantity, unit, transaction_ref, created_by) values ('x', now(), '${m}', 1, 'pcs', 'x', '${U.alice}')`,
        `insert into public.audit_logs (action, entity) values ('x', 'x')`,
        `delete from public.inventory_transactions`,
        `update public.inventory_transactions set quantity = 1`,
      ]
      for (const a of attempts) await rejects(db.as(U.alice, a), /permission denied/)
      const admin = U.admin
      for (const a of attempts.slice(0, 5)) await rejects(db.as(admin, a), /permission denied/) // even admins must use the functions
    })

    it('standard users cannot call administrator functions', async () => {
      const m = ids['PVC-D35']
      await rejects(db.rpc(U.alice, 'admin_record_opening_stock', { p_items: [{ material_id: m, kind: 'full', quantity: 5 }] }), /FORBIDDEN/)
      await rejects(db.rpc(U.alice, 'admin_record_purchase', { p: { material_id: m, quantity: 5 } }), /FORBIDDEN/)
      await rejects(db.rpc(U.alice, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'full', p_delta: 5, p_reason: 'hack' }), /FORBIDDEN/)
      await rejects(db.rpc(U.alice, 'admin_update_settings', { p: { pipe_stock_length: 6 } }), /FORBIDDEN/)
      await rejects(db.rpc(U.alice, 'admin_update_material', { p_id: m, p_sku: 'X', p_name: 'X', p_name_vi: 'X', p_low_stock: 0 }), /FORBIDDEN/)
      await rejects(db.rpc(U.alice, 'admin_update_profile', { p_user: U.alice, p_role: 'admin' }), /FORBIDDEN/)
      await rejects(db.rpc(U.alice, 'admin_reverse_installation', { p_installation: randomUUID(), p_reason: 'because' }), /FORBIDDEN/)
      expect(await balance(db, 'PVC-D35', 'full')).toBe(20)
    })

    it('internal helper functions are not callable from the browser', async () => {
      await rejects(db.as(U.admin, `select public._post_ledger('x', '${ids['PVC-D35']}', 'full', 'adjustment', 5, '${U.admin}', null, null, null, null)`), /permission denied/)
      await rejects(db.as(U.admin, `select public._audit('x','y','z','{}')`), /permission denied/)
    })

    it('ledger and audit rows are immutable even for a superuser', async () => {
      await rejects(db.admin(`update public.inventory_transactions set notes = 'tampered'`), /IMMUTABLE/)
      await rejects(db.admin(`delete from public.inventory_transactions`), /IMMUTABLE/)
      await rejects(db.admin(`update public.audit_logs set action = 'x'`), /IMMUTABLE/)
      await rejects(db.admin(`delete from public.audit_logs`), /IMMUTABLE/)
    })

    it('negative inventory is impossible at table level', async () => {
      await rejects(db.admin(`update public.inventory_balances set quantity = -1 where bucket = 'cap'`), /check constraint/)
    })

    it('a disabled account sees and can do nothing', async () => {
      await db.rpc(U.admin, 'admin_update_profile', { p_user: U.carol, p_active: false })
      expect(await db.as(U.carol, 'select * from public.materials')).toHaveLength(0)
      expect(await db.as(U.carol, 'select id from public.profiles')).toHaveLength(1) // only its own row, to explain why
      await rejects(db.rpc(U.carol, 'save_installation', { p: { client_request_id: randomUUID(), locations: [] } }), /FORBIDDEN/)
      await rejects(db.as(U.carol, 'select * from public.get_inventory_overview()'), /FORBIDDEN/)
      await db.rpc(U.admin, 'admin_update_profile', { p_user: U.carol, p_active: true })
    })

    it('the last active administrator cannot be removed; standard users cannot change roles', async () => {
      await db.rpc(U.admin, 'admin_update_profile', { p_user: U.admin2, p_role: 'user' })
      await rejects(db.rpc(U.admin, 'admin_update_profile', { p_user: U.admin, p_role: 'user' }), /LAST_ADMIN/)
      await rejects(db.rpc(U.admin, 'admin_update_profile', { p_user: U.admin, p_active: false }), /LAST_ADMIN/)
      await db.rpc(U.admin, 'admin_update_profile', { p_user: U.admin2, p_role: 'admin' })
      const audit = await db.as(U.admin, `select action from public.audit_logs where action = 'user.update'`)
      expect(audit.length).toBeGreaterThanOrEqual(3)
    })

    it('users may set only their own language', async () => {
      await db.rpc(U.alice, 'set_my_language', { p_lang: 'en' })
      const r = await db.admin(`select id, language from public.profiles where language = 'en'`)
      expect(r.map((x) => x.id)).toEqual([U.alice])
      await rejects(db.rpc(U.alice, 'set_my_language', { p_lang: 'xx' }), /VALIDATION/)
    })
  })

  // ============================================================== ADMIN STOCK OPERATIONS
  describe(`[${label}] opening stock, purchases, adjustments (admin only)`, () => {
    let db: TestDb
    let ids: Record<string, string>
    beforeAll(async () => {
      db = await makeDb()
      await seedUsers(db)
      ids = await matIds(db)
    })
    afterAll(async () => db.close())

    it('records opening stock through a controlled transaction (ledger, offcut pieces, audit)', async () => {
      const r = await seedStock(db, ids)
      expect(r.ok).toBe(true)
      expect(r.transaction_ref).toMatch(/^TXN-/)
      expect(await balance(db, 'PVC-D35', 'full')).toBe(20)
      expect(await balance(db, 'PVC-D35', 'offcut')).toBe(4.5)
      expect(await balance(db, 'SCR-D35', 'screen')).toBe(30)
      expect(await balance(db, 'SCR-D55', 'screen')).toBe(40)
      expect(await balance(db, 'CAP-D90', 'cap')).toBe(10)
      const offcuts = await db.admin(`select length::text l from public.pipe_offcuts where status = 'available' order by length`)
      expect(offcuts.map((o) => Number(o.l))).toEqual([1, 1, 2.5]) // individual pieces, not one 4.5 m lump
      const led = await db.admin(`select tx_type, quantity::text q, balance_before::text b0, balance_after::text b1 from public.inventory_transactions where bucket = 'full' order by tx_ref`)
      expect(led.every((l) => l.tx_type === 'opening_stock')).toBe(true)
      expect(Number(led[0].b0)).toBe(0)
      expect(Number(led[0].b1)).toBe(Number(led[0].q))
      expect((await db.admin(`select count(*)::int n from public.audit_logs where action = 'stock.opening'`))[0].n).toBe(1)
      await expectIntegrity(db)
    })

    it('opening stock can be topped up again but never silently overwrites: balances only move through ledger rows', async () => {
      const before = await balance(db, 'PVC-D35', 'full')
      await db.rpc(U.admin, 'admin_record_opening_stock', { p_items: [{ material_id: ids['PVC-D35'], kind: 'full', quantity: 3 }], p_notes: 'late count' })
      expect(await balance(db, 'PVC-D35', 'full')).toBe(before + 3)
      await expectIntegrity(db)
    })

    it('validates opening stock lines and rolls back the whole batch when one line is bad', async () => {
      const snap = await snapshot(db)
      await rejects(
        db.rpc(U.admin, 'admin_record_opening_stock', {
          p_items: [
            { material_id: ids['CAP-D35'], kind: 'cap', quantity: 5 },
            { material_id: ids['PVC-D35'], kind: 'offcut', quantity: 1, length: 4 }, // as long as a full pipe
          ],
        }),
        /shorter than a full/,
      )
      expect(await snapshot(db)).toBe(snap)
      await rejects(db.rpc(U.admin, 'admin_record_opening_stock', { p_items: [{ material_id: ids['PVC-D35'], kind: 'full', quantity: 2.5 }] }), /whole number/)
      await rejects(db.rpc(U.admin, 'admin_record_opening_stock', { p_items: [{ material_id: ids['PVC-D35'], kind: 'full', quantity: -1 }] }), /whole number/)
      await rejects(db.rpc(U.admin, 'admin_record_opening_stock', { p_items: [{ material_id: ids['CAP-D35'], kind: 'full', quantity: 1 }] }), /not a pipe/)
      await rejects(db.rpc(U.admin, 'admin_record_opening_stock', { p_items: [] }), /no opening stock/)
      expect(await snapshot(db)).toBe(snap)
    })

    it('records purchases: pipes, screens (needs total metres) and caps', async () => {
      const d35 = await balance(db, 'PVC-D35', 'full')
      const scr = await balance(db, 'SCR-D55', 'screen')
      const cap = await balance(db, 'CAP-D55', 'cap')
      const a = await db.rpc(U.admin, 'admin_record_purchase', { p: { purchase_date: '2026-10-20', supplier: 'Binh Minh', material_id: ids['PVC-D35'], quantity: 5, reference_no: 'PO-77', notes: 'n' } })
      const b = await db.rpc(U.admin, 'admin_record_purchase', { p: { material_id: ids['SCR-D55'], quantity: 2, total_length: 12.5 } })
      const c = await db.rpc(U.admin, 'admin_record_purchase', { p: { material_id: ids['CAP-D55'], quantity: 7 } })
      expect(a.ok && b.ok && c.ok).toBe(true)
      expect(await balance(db, 'PVC-D35', 'full')).toBe(d35 + 5)
      expect(await balance(db, 'SCR-D55', 'screen')).toBe(scr + 12.5)
      expect(await balance(db, 'CAP-D55', 'cap')).toBe(cap + 7)
      const p = await db.admin(`select supplier, reference_no, total_length::text tl, created_by from public.purchases where ref = $1`, [a.ref])
      expect(p[0]).toMatchObject({ supplier: 'Binh Minh', reference_no: 'PO-77', created_by: U.admin })
      expect(Number(p[0].tl)).toBe(20) // 5 pipes x 4 m
      const led = await db.admin(`select tx_type, purchase_id from public.inventory_transactions where purchase_id is not null`)
      expect(led).toHaveLength(3)
      await rejects(db.rpc(U.admin, 'admin_record_purchase', { p: { material_id: ids['SCR-D55'], quantity: 2 } }), /total length/)
      await rejects(db.rpc(U.admin, 'admin_record_purchase', { p: { material_id: ids['CAP-D55'], quantity: 0 } }), /positive/)
      await expectIntegrity(db)
    })

    it('adjustments need a reason, can never make stock negative, and are fully documented', async () => {
      const m = ids['CAP-D90']
      const before = await balance(db, 'CAP-D90', 'cap')
      await rejects(db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'cap', p_delta: -1, p_reason: '' }), /reason/)
      await rejects(db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'cap', p_delta: -(before + 1), p_reason: 'count error' }), /NEGATIVE_STOCK/)
      expect(await balance(db, 'CAP-D90', 'cap')).toBe(before)
      const r = await db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'cap', p_delta: -2, p_reason: 'Damaged caps found' })
      expect(r.ok).toBe(true)
      expect(await balance(db, 'CAP-D90', 'cap')).toBe(before - 2)
      const led = await db.admin(`select tx_type, quantity::text q, notes, user_id, balance_before::text b0, balance_after::text b1 from public.inventory_transactions where material_id = $1 and tx_type = 'adjustment'`, [m])
      expect(led).toHaveLength(1)
      expect(led[0]).toMatchObject({ tx_type: 'adjustment', notes: 'Damaged caps found', user_id: U.admin })
      expect(Number(led[0].b0) - 2).toBe(Number(led[0].b1))
      await rejects(db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'full', p_delta: 1, p_reason: 'wrong bucket' }), /does not exist/)
      await rejects(db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'cap', p_delta: 1.5, p_reason: 'fraction' }), /whole/)
    })

    it('adjusts individual offcuts: remove a damaged piece, add a found piece', async () => {
      const m = ids['PVC-D35']
      const off = await db.admin(`select id from public.pipe_offcuts where material_id = $1 and status = 'available' and length = 2.5`, [m])
      const before = await balance(db, 'PVC-D35', 'offcut')
      await db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'offcut', p_delta: 0, p_reason: 'cracked piece', p_offcut_id: off[0].id })
      expect(await balance(db, 'PVC-D35', 'offcut')).toBe(before - 2.5)
      await rejects(db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'offcut', p_delta: 0, p_reason: 'again', p_offcut_id: off[0].id }), /not available/)
      await db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'offcut', p_delta: 0, p_reason: 'found in yard', p_offcut_length: 1.75 })
      expect(await balance(db, 'PVC-D35', 'offcut')).toBe(before - 2.5 + 1.75)
      await rejects(db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: m, p_bucket: 'offcut', p_delta: 0, p_reason: 'too long', p_offcut_length: 4 }), /shorter than a full pipe/)
      await expectIntegrity(db)
    })

    it('overview aggregates reconcile: opening + purchased - consumed + adjusted + reversed = available', async () => {
      const rows = await db.as(U.alice, 'select * from public.get_inventory_overview()')
      expect(rows).toHaveLength(8)
      for (const r of rows) expect(num(r.opening) + num(r.purchased) - num(r.consumed) + num(r.adjusted) + num(r.reversed)).toBeCloseTo(num(r.available), 6)
      const d35 = rows.find((r) => r.sku === 'PVC-D35')!
      expect(num(d35.offcut_count)).toBe(3) // 1 + 1 + 1.75
    })

    it('updates material master data (name, SKU, threshold) with unique SKU enforcement', async () => {
      await db.rpc(U.admin, 'admin_update_material', { p_id: ids['CAP-D35'], p_sku: 'CAP-35', p_name: 'Cap 35', p_name_vi: 'Nắp 35', p_low_stock: 15 })
      const r = await db.admin(`select sku, name, low_stock_threshold::text t from public.materials where id = $1`, [ids['CAP-D35']])
      expect(r[0]).toMatchObject({ sku: 'CAP-35', name: 'Cap 35' })
      await rejects(db.rpc(U.admin, 'admin_update_material', { p_id: ids['CAP-D35'], p_sku: 'PVC-D35', p_name: 'x', p_name_vi: '', p_low_stock: 1 }), /already used/)
      await db.rpc(U.admin, 'admin_update_material', { p_id: ids['CAP-D35'], p_sku: 'CAP-D35', p_name: 'PVC Cap D35', p_name_vi: 'Nắp PVC D35', p_low_stock: 10 })
    })
  })

  // ============================================================== INSTALLATION FLOW
  describe(`[${label}] saving installations: atomic, validated, idempotent`, () => {
    let db: TestDb
    let ids: Record<string, string>
    beforeAll(async () => {
      db = await makeDb()
      await seedUsers(db)
      ids = await matIds(db)
      await seedStock(db, ids, { d35: 200, d55: 100, d90: 100, c35: 200, c55: 100, c90: 100 })
    })
    afterAll(async () => db.close())

    it('Calculate only previews: nothing is deducted until Save', async () => {
      const snap = await snapshot(db)
      const c = await calcFor(db, U.alice, [P('BH-01', 12.5)])
      expect(c.res.canSave).toBe(true)
      expect(await snapshot(db)).toBe(snap)
    })

    it('Test A saved: stock, caps, screen and offcuts move exactly as calculated; ledger is consistent', async () => {
      // use a clean inventory slice: D35 offcuts exist (2.5, 1, 1) so the plan reuses them first
      const before = { full: await balance(db, 'PVC-D35', 'full'), scr: await balance(db, 'SCR-D35', 'screen'), cap: await balance(db, 'CAP-D35', 'cap'), off: await balance(db, 'PVC-D35', 'offcut') }
      const { out, res } = await save(db, U.alice, [P('BH-01', 12.5)])
      expect(out.ok).toBe(true)
      expect(out.ref).toMatch(/^INS-/)
      expect(out.transaction_ref).toMatch(/^TXN-/)
      const plan = res.pipePlans[0]
      expect(plan.offcutsConsumed.length).toBeGreaterThan(0) // existing offcuts are used before cutting new pipes
      expect(plan.newPipes).toBeLessThanOrEqual(3) // 12.5 m would need 4 new pipes without the offcuts
      expect(await balance(db, 'PVC-D35', 'full')).toBe(before.full - plan.newPipes)
      expect(await balance(db, 'SCR-D35', 'screen')).toBe(before.scr - 1)
      expect(await balance(db, 'CAP-D35', 'cap')).toBe(before.cap - 2)
      expect(await balance(db, 'PVC-D35', 'offcut')).toBeCloseTo(before.off - plan.offcutsConsumedMm / 1000 + plan.generatedMm / 1000, 6)
      await expectIntegrity(db)
      // every ledger row of the operation carries the same group reference and valid before/after
      const led = await db.admin(`select tx_type, bucket, quantity::text q, balance_before::text b0, balance_after::text b1, installation_id, user_id from public.inventory_transactions where group_ref = $1 order by tx_ref`, [out.transaction_ref])
      expect(led.length).toBeGreaterThanOrEqual(5)
      for (const l of led) {
        expect(Number(l.b0) + Number(l.q)).toBeCloseTo(Number(l.b1), 6)
        expect(l.installation_id).toBe(out.installation_id)
        expect(l.user_id).toBe(U.alice)
      }
      expect(led.map((l) => l.tx_type)).toEqual(expect.arrayContaining(['offcut_consumed', 'installation_issue']))
    })

    it('stores the full record: locations, cutting plan, usage lines (top & bottom caps separate), settings snapshot', async () => {
      const { out, res } = await save(db, U.alice, [P('BH-02', 15), { type: 'seismic', code: 'SM-01', depthM: 20 }])
      expect(out.ok).toBe(true)
      const inst = (await db.admin(`select * from public.installations where id = $1`, [out.installation_id]))[0]
      expect(inst.status).toBe('completed')
      expect(Number(inst.total_depth)).toBe(35)
      expect(inst.created_by).toBe(U.alice)
      expect(inst.settings_snapshot.settings.pipe_stock_length).toBe(4)
      expect(inst.settings_snapshot.effective.stock_length).toBe(4)
      expect(inst.calculation.locations).toHaveLength(2)
      const locs = await db.admin(`select location_code, installation_type, depth::text d, projection::text p, screen_length::text s, total_length::text t, pvc_length::text v from public.installation_locations where installation_id = $1 order by line_no`, [out.installation_id])
      expect(locs.map((l) => [l.location_code, Number(l.d), Number(l.p), Number(l.s), Number(l.t), Number(l.v)])).toEqual([
        ['BH-02', 15, 1, 1, 16, 15],
        ['SM-01', 20, 0.5, 0, 20.5, 20.5],
      ])
      const steps = await db.admin(`select count(*)::int n, sum(cut_length)::text c from public.installation_cutting_plans where installation_id = $1`, [out.installation_id])
      expect(steps[0].n).toBe(res.steps.length)
      expect(Number(steps[0].c)).toBe(35.5)
      const usage = await db.admin(`select component, count(*)::int n from public.installation_material_usage where installation_id = $1 group by component`, [out.installation_id])
      const u = Object.fromEntries(usage.map((x) => [x.component, x.n]))
      expect(u).toMatchObject({ pvc: 2, screen: 1, top_cap: 2, bottom_cap: 2 })
      expect((await db.admin(`select count(*)::int n from public.audit_logs where action = 'installation.create' and entity_id = $1`, [out.installation_id]))[0].n).toBe(1)
      await expectIntegrity(db)
    })

    it('double submission (same request id) never deducts twice and returns the original record', async () => {
      const locs = [P('DUP-1', 6)]
      const c = await calcFor(db, U.alice, locs)
      const p = payloadFor(c.res, locs)
      const fullBefore = await balance(db, 'PVC-D35', 'full')
      const first = await db.rpc(U.alice, 'save_installation', { p })
      const second = await db.rpc(U.alice, 'save_installation', { p })
      const third = await db.rpc(U.alice, 'save_installation', { p })
      expect(first.ok && first.duplicate === false).toBe(true)
      expect(second).toMatchObject({ ok: true, duplicate: true, installation_id: first.installation_id, ref: first.ref })
      expect(third.installation_id).toBe(first.installation_id)
      expect((await db.admin(`select count(*)::int n from public.installations where client_request_id = $1`, [p.client_request_id]))[0].n).toBe(1)
      expect(await balance(db, 'PVC-D35', 'full')).toBe(fullBefore - c.res.pipePlans[0].newPipes)
      // someone else cannot replay another user's request id
      await rejects(db.rpc(U.bob, 'save_installation', { p }), /FORBIDDEN/)
      await expectIntegrity(db)
    })

    it('insufficient stock: exact shortages returned, nothing saved, nothing deducted', async () => {
      await db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: ids['CAP-D90'], p_bucket: 'cap', p_delta: -(await balance(db, 'CAP-D90', 'cap')) + 1, p_reason: 'leave one cap' })
      const snap = await snapshot(db)
      const c = await calcFor(db, U.alice, [{ type: 'seismic', code: 'SM-9', depthM: 10 }])
      expect(c.res.canSave).toBe(false)
      const out = await db.rpc(U.alice, 'save_installation', { p: payloadFor(c.res, [{ type: 'seismic', code: 'SM-9', depthM: 10 }]) })
      expect(out).toMatchObject({ ok: false, error: 'INSUFFICIENT_STOCK' })
      expect(out.shortages).toHaveLength(1)
      expect(out.shortages[0]).toMatchObject({ sku: 'CAP-D90', bucket: 'cap', required: 2, available: 1, missing: 1 })
      // engine and database agree on the shortage
      expect(c.res.shortages.map((s) => s.missing)).toEqual([1])
      expect(await snapshot(db)).toBe(snap)
      await db.rpc(U.admin, 'admin_adjust_inventory', { p_material_id: ids['CAP-D90'], p_bucket: 'cap', p_delta: 9, p_reason: 'recount' })
    })

    it('rejects a stale plan whose offcut was consumed in the meantime (two users, same offcut)', async () => {
      // plan for alice and bob computed from the same inventory, each wanting the single 2.5/1/1 style offcuts
      await db.rpc(U.admin, 'admin_record_opening_stock', { p_items: [{ material_id: ids['PVC-D55'], kind: 'offcut', quantity: 1, length: 3.0 }] })
      const locsA: LocationInput[] = [{ type: 'standpipe', code: 'A-1', depthM: 3.0, screenM: 1 }] // pvc = 3.0 -> exactly the offcut
      const locsB: LocationInput[] = [{ type: 'standpipe', code: 'B-1', depthM: 3.0, screenM: 1 }]
      const ca = await calcFor(db, U.alice, locsA)
      const cb = await calcFor(db, U.bob, locsB)
      expect(ca.res.steps[0].source).toBe('offcut')
      expect(cb.res.steps[0].offcutId).toBe(ca.res.steps[0].offcutId)
      const a = await db.rpc(U.alice, 'save_installation', { p: payloadFor(ca.res, locsA) })
      const snap = await snapshot(db)
      const b = await db.rpc(U.bob, 'save_installation', { p: payloadFor(cb.res, locsB) })
      expect(a.ok).toBe(true)
      expect(b).toMatchObject({ ok: false, error: 'STALE_PLAN' })
      expect(await snapshot(db)).toBe(snap)
      // after recalculating, bob succeeds with new pipes
      const again = await save(db, U.bob, locsB)
      expect(again.out.ok).toBe(true)
      expect(again.res.steps[0].source).toBe('stock')
      await expectIntegrity(db)
    })

    it('tampered plans are rejected and leave no trace (atomic)', async () => {
      const locs = [P('T-1', 12.5)]
      const c = await calcFor(db, U.alice, locs)
      const good = payloadFor(c.res, locs)
      const bad = async (mutate: (p: any) => void, re: RegExp) => {
        const snap = await snapshot(db)
        const p: any = JSON.parse(JSON.stringify(good))
        p.client_request_id = randomUUID()
        mutate(p)
        await rejects(db.rpc(U.alice, 'save_installation', { p }), re)
        expect(await snapshot(db)).toBe(snap)
      }
      await bad((p) => p.plan.pop(), /does not exactly cover/) // not enough pipe
      await bad((p) => (p.plan[0].cut_length += 0.001, p.plan[0].source_length = 4.001), /new pipe is exactly 4|offcut length does not match/)
      await bad((p) => (p.plan[0].cut_length = 5), /longer than its source/)
      await bad((p) => (p.plan[0].cut_length = -1), /positive/)
      await bad((p) => (p.plan[0].source = 'magic'), /unknown cutting plan source/)
      await bad((p) => (p.plan[0].location = 7), /unknown location/)
      await bad((p) => p.plan.push({ ...p.plan[0], step: 99 }), /does not exactly cover|used twice/) // pipe cut twice for the same need
      await bad((p) => (p.plan[0] = { ...p.plan[0], source: 'offcut', offcut_id: randomUUID() }), /unknown offcut/)
      await bad((p) => (p.plan[0] = { ...p.plan[0], source: 'generated', source_ref: 'nope' }), /does not exist or was already used/)
      await bad((p) => (p.locations[0].depth = -5), /positive/)
      await bad((p) => (p.locations[0].depth = 1.2345), /3 decimals/)
      await bad((p) => (p.locations[0].screen_length = 99), /exceeds the total installed length|FORBIDDEN/)
      await bad((p) => (p.locations[0].type = 'bogus'), /unknown installation type/)
      await bad((p) => (p.locations[0].code = '  '), /identifier is required/)
      await bad((p) => p.locations.push({ ...p.locations[0] }), /duplicate location identifiers/)
      await bad((p) => (p.locations = []), /at least one/)
      await bad((p) => delete p.client_request_id, /client_request_id/)
    })

    it('cross-diameter offcut abuse is rejected (a D55 offcut cannot serve a D35 location)', async () => {
      const d55off = (await db.admin(`select o.id from public.pipe_offcuts o join public.materials m on m.id = o.material_id where m.sku = 'PVC-D55' and o.status = 'available' limit 1`))[0]
      await db.rpc(U.admin, 'admin_record_opening_stock', { p_items: [{ material_id: ids['PVC-D55'], kind: 'offcut', quantity: 1, length: 1.0 }] })
      const x = (await db.admin(`select o.id, o.length::text l from public.pipe_offcuts o join public.materials m on m.id = o.material_id where m.sku = 'PVC-D55' and o.status = 'available' limit 1`))[0]
      void d55off
      const locs = [P('X-1', 0.5, 0)] // pvc 1.5 m
      const c = await calcFor(db, U.alice, locs)
      const p: any = payloadFor(c.res, locs)
      p.plan = [{ step: 1, location: 0, source: 'offcut', offcut_id: x.id, source_ref: null, source_length: Number(x.l), cut_length: 1.0, leftover_ref: null }, ...p.plan.slice(1)]
      const snap = await snapshot(db)
      await rejects(db.rpc(U.alice, 'save_installation', { p }), /different diameter|does not exactly cover/)
      expect(await snapshot(db)).toBe(snap)
    })

    it('injected failure while writing rolls back EVERYTHING (no partial installation, no partial deduction)', async () => {
      await db.exec(`
        create or replace function public.test_boom() returns trigger language plpgsql as $$
        begin if new.bucket = 'cap' and new.tx_type = 'installation_issue' then raise exception 'BOOM injected failure'; end if; return new; end $$;
        create trigger test_boom_trg before insert on public.inventory_transactions for each row execute function public.test_boom();`)
      try {
        const locs = [P('BOOM-1', 9)]
        const c = await calcFor(db, U.alice, locs)
        const snap = await snapshot(db)
        await rejects(db.rpc(U.alice, 'save_installation', { p: payloadFor(c.res, locs) }), /BOOM/)
        expect(await snapshot(db)).toBe(snap) // installation row, plan, usage, offcuts, pipes, screens - all unchanged
      } finally {
        await db.exec(`drop trigger test_boom_trg on public.inventory_transactions; drop function public.test_boom();`)
      }
      await expectIntegrity(db)
    })

    it('multiple locations and mixed types in one record: separate material lines, 6 D35 caps for 3 piezometers', async () => {
      const locs: LocationInput[] = [P('M-1', 12.5), P('M-2', 15), P('M-3', 8), { type: 'permeability', code: 'K-1', depthM: 10 }, { type: 'standpipe', code: 'S-1', depthM: 18 }]
      const capD35 = await balance(db, 'CAP-D35', 'cap')
      const { out, res } = await save(db, U.alice, locs)
      expect(out.ok).toBe(true)
      expect(res.caps.find((c) => c.total === 8)).toBeTruthy() // 4 D35 locations -> 8 caps
      expect(await balance(db, 'CAP-D35', 'cap')).toBe(capD35 - 8)
      const usage = await db.admin(`select component, sum(quantity)::text q from public.installation_material_usage where installation_id = $1 group by component`, [out.installation_id])
      const u = Object.fromEntries(usage.map((x) => [x.component, Number(x.q)]))
      expect(u.top_cap).toBe(5)
      expect(u.bottom_cap).toBe(5)
      await expectIntegrity(db)
    })

    it('screen override policy: allowed by default, blocked for standard users when Admin disables it (admins always may)', async () => {
      const ok = await save(db, U.alice, [P('SC-1', 10, 2.5)])
      expect(ok.out.ok).toBe(true)
      expect(Number((await db.admin(`select screen_length::text s from public.installation_locations where installation_id = $1`, [ok.out.installation_id]))[0].s)).toBe(2.5)
      await db.rpc(U.admin, 'admin_update_settings', { p: { allow_user_screen_override: false } })
      const locs = [P('SC-2', 10, 2.5)]
      const c = await calcFor(db, U.alice, locs)
      await rejects(db.rpc(U.alice, 'save_installation', { p: payloadFor(c.res, locs) }), /FORBIDDEN.*overriding the screen/)
      expect((await save(db, U.admin, [P('SC-3', 10, 2.5)])).out.ok).toBe(true)
      expect((await save(db, U.alice, [P('SC-4', 10, 1)])).out.ok).toBe(true) // same as default is fine
      await db.rpc(U.admin, 'admin_update_settings', { p: { allow_user_screen_override: true } })
    })

    it('settings changes apply to FUTURE calculations only; every record keeps its own settings snapshot', async () => {
      const old = await save(db, U.alice, [P('SN-1', 10)])
      await db.rpc(U.admin, 'admin_update_settings', { p: { screen_default_piezometer: 1.5, projection_standard: 1.2 } })
      const fresh = await save(db, U.alice, [P('SN-2', 10)])
      const rows = await db.admin(`select i.ref, l.screen_length::text s, l.projection::text p, i.settings_snapshot->'settings'->>'screen_default_piezometer' snap from public.installations i join public.installation_locations l on l.installation_id = i.id where i.id in ($1, $2) order by i.created_at, i.ref`, [old.out.installation_id, fresh.out.installation_id])
      const byRef = Object.fromEntries(rows.map((r) => [r.ref, r]))
      expect([Number(byRef[old.out.ref].s), Number(byRef[old.out.ref].p), Number(byRef[old.out.ref].snap)]).toEqual([1, 1, 1])
      expect([Number(byRef[fresh.out.ref].s), Number(byRef[fresh.out.ref].p), Number(byRef[fresh.out.ref].snap)]).toEqual([1.5, 1.2, 1.5])
      expect((await db.admin(`select count(*)::int n from public.audit_logs where action = 'settings.update'`))[0].n).toBeGreaterThanOrEqual(2)
      await db.rpc(U.admin, 'admin_update_settings', { p: { screen_default_piezometer: 1, projection_standard: 1 } })
    })

    it('settings are validated; the pipe length is locked while full pipes are in stock', async () => {
      await rejects(db.rpc(U.admin, 'admin_update_settings', { p: { unknown_key: 1 } }), /unknown setting/)
      await rejects(db.rpc(U.admin, 'admin_update_settings', { p: { allow_joints: 'yes' } }), /true or false/)
      await rejects(db.rpc(U.admin, 'admin_update_settings', { p: { projection_standard: -1 } }), />= 0/)
      await rejects(db.rpc(U.admin, 'admin_update_settings', { p: { cutting_allowance: 4, cutting_allowance_enabled: true } }), /smaller than the pipe length/)
      await rejects(db.rpc(U.admin, 'admin_update_settings', { p: { pipe_stock_length: 6 } }), /STOCK_LENGTH_LOCKED/)
      expect(Number((await db.admin(`select stock_length::text s from public.materials where sku = 'PVC-D35'`))[0].s)).toBe(4)
    })

    it('no-joint policy and cutting allowance are enforced by the database as well', async () => {
      await db.rpc(U.admin, 'admin_update_settings', { p: { allow_joints: false } })
      const locs = [P('NJ-1', 12.5)]
      const c0 = await calcFor(db, U.alice, locs)
      expect(c0.res.ok).toBe(false)
      expect(c0.res.issues[0].code).toBe('JOINT_REQUIRED')
      // a hand-made plan with joints is refused by the database
      await db.rpc(U.admin, 'admin_update_settings', { p: { allow_joints: true } })
      const c1 = await calcFor(db, U.alice, locs)
      await db.rpc(U.admin, 'admin_update_settings', { p: { allow_joints: false } })
      await rejects(db.rpc(U.alice, 'save_installation', { p: payloadFor(c1.res, locs) }), /joining several pipe segments is not permitted/)
      await db.rpc(U.admin, 'admin_update_settings', { p: { allow_joints: true, cutting_allowance_enabled: true, cutting_allowance: 0.003 } })
      const k = await save(db, U.alice, [P('KERF-1', 6.5, 0)])
      expect(k.out.ok).toBe(true)
      const kerf = await db.admin(`select sum(kerf_length)::text k from public.installation_cutting_plans where installation_id = $1`, [k.out.installation_id])
      expect(Number(kerf[0].k)).toBeGreaterThan(0)
      // a plan that claims no kerf is recomputed by the database, so the ledger stays exact
      await db.rpc(U.admin, 'admin_update_settings', { p: { cutting_allowance_enabled: false, cutting_allowance: 0 } })
      await expectIntegrity(db)
    })

    it('Test A-D exact acceptance figures survive the database round trip (fresh inventory, no offcuts)', async () => {
      const expectations: [LocationInput, string, number, number][] = [
        [{ type: 'piezometer', code: 'A', depthM: 12.5 }, 'PVC-D35', 4, 3.5],
        [{ type: 'standpipe', code: 'B', depthM: 18 }, 'PVC-D55', 4, 2],
        [{ type: 'permeability', code: 'C', depthM: 10 }, 'PVC-D35', 3, 2],
        [{ type: 'seismic', code: 'D', depthM: 20 }, 'PVC-D90', 6, 3.5],
      ]
      for (const [loc, sku, pipes, unused] of expectations) {
        const fresh = await makeDb() // a clean database per case so no earlier leftover is reused
        try {
          await seedUsers(fresh)
          const fids = await matIds(fresh)
          await fresh.rpc(U.admin, 'admin_record_opening_stock', {
            p_items: [
              { material_id: fids['PVC-D35'], kind: 'full', quantity: 50 }, { material_id: fids['PVC-D55'], kind: 'full', quantity: 50 }, { material_id: fids['PVC-D90'], kind: 'full', quantity: 50 },
              { material_id: fids['SCR-D35'], kind: 'screen', quantity: 5, length: 10 }, { material_id: fids['SCR-D55'], kind: 'screen', quantity: 5, length: 10 },
              { material_id: fids['CAP-D35'], kind: 'cap', quantity: 20 }, { material_id: fids['CAP-D55'], kind: 'cap', quantity: 20 }, { material_id: fids['CAP-D90'], kind: 'cap', quantity: 20 },
            ],
          })
          const { out } = await save(fresh, U.alice, [loc])
          expect(out.ok).toBe(true)
          const after = Number((await fresh.admin(`select b.quantity::text q from public.inventory_balances b join public.materials m on m.id = b.material_id where m.sku = $1 and b.bucket = 'full'`, [sku]))[0].q)
          expect(50 - after).toBe(pipes)
          const calc = (await fresh.admin(`select calculation from public.installations where id = $1`, [out.installation_id]))[0].calculation
          const p = calc.pipes[0]
          expect(Number(p.new_pipes)).toBe(pipes)
          expect(Number(p.offcuts_generated_m) + Number(p.scrap_m) + Number(p.kerf_m)).toBeCloseTo(unused, 6)
          const caps = (await fresh.admin(`select coalesce(sum(quantity),0)::text q from public.installation_material_usage where installation_id = $1 and component in ('top_cap','bottom_cap')`, [out.installation_id]))[0].q
          expect(Number(caps)).toBe(2)
          await expectIntegrity(fresh)
        } finally {
          await fresh.close()
        }
      }
    })
  })

  // ============================================================== REVERSAL, VISIBILITY, DASHBOARD
  describe(`[${label}] reversals, visibility rules and dashboard totals`, () => {
    let db: TestDb
    let ids: Record<string, string>
    beforeAll(async () => {
      db = await makeDb()
      await seedUsers(db)
      ids = await matIds(db)
      await seedStock(db, ids)
    })
    afterAll(async () => db.close())

    it('reverses an installation with a documented reversal; later dependent reuse blocks an earlier reversal', async () => {
      const first = await save(db, U.alice, [P('R-1', 2.5, 0)]) // pvc 3.5 -> reuses offcuts, creates leftovers
      // a later job that consumes an offcut created by the first
      const gen = (await db.admin(`select id, length::text l from public.pipe_offcuts where origin_installation_id = $1 and status = 'available'`, [first.out.installation_id]))
      const second = await save(db, U.bob, [P('R-2', 0.5, 0)])
      const usedSecond = (await db.admin(`select count(*)::int n from public.pipe_offcuts where consumed_installation_id = $1 and origin_installation_id = $2`, [second.out.installation_id, first.out.installation_id]))[0].n
      void gen
      if (usedSecond > 0) {
        await rejects(db.rpc(U.admin, 'admin_reverse_installation', { p_installation: first.out.installation_id, p_reason: 'wrong borehole' }), /REVERSAL_BLOCKED/)
      }
      const before = await snapshot(db)
      void before
      // reverse the latest first
      const r2 = await db.rpc(U.admin, 'admin_reverse_installation', { p_installation: second.out.installation_id, p_reason: 'duplicate entry' })
      expect(r2.ok).toBe(true)
      await expectIntegrity(db)
      const r1 = await db.rpc(U.admin, 'admin_reverse_installation', { p_installation: first.out.installation_id, p_reason: 'wrong borehole' })
      expect(r1.ok).toBe(true)
      await expectIntegrity(db)
      // stock is back to the opening figures
      expect(await balance(db, 'PVC-D35', 'full')).toBe(20)
      expect(await balance(db, 'PVC-D35', 'offcut')).toBe(4.5)
      expect(await balance(db, 'SCR-D35', 'screen')).toBe(30)
      expect(await balance(db, 'CAP-D35', 'cap')).toBe(20)
      const lens = await db.admin(`select length::text l from public.pipe_offcuts where status = 'available' order by length`)
      expect(lens.map((x) => Number(x.l))).toEqual([1, 1, 2.5])
      const st = await db.admin(`select status, reversal_reason, reversed_by from public.installations where id = $1`, [first.out.installation_id])
      expect(st[0]).toMatchObject({ status: 'reversed', reversal_reason: 'wrong borehole', reversed_by: U.admin })
      await rejects(db.rpc(U.admin, 'admin_reverse_installation', { p_installation: first.out.installation_id, p_reason: 'again' }), /already reversed/)
      await rejects(db.rpc(U.admin, 'admin_reverse_installation', { p_installation: randomUUID(), p_reason: 'xyz' }), /not found/)
      await rejects(db.admin(`update public.installations set total_depth = 1 where id = '${first.out.installation_id}'`), /IMMUTABLE/)
      await rejects(db.admin(`delete from public.installations where id = '${first.out.installation_id}'`), /IMMUTABLE/)
      const rev = await db.admin(`select count(*)::int n from public.inventory_transactions where tx_type = 'reversal'`)
      expect(rev[0].n).toBeGreaterThan(0)
    })

    it('history visibility: users see their own records, admins see all, "view all" switch works', async () => {
      const a = await save(db, U.alice, [P('V-A', 5)])
      const b = await save(db, U.bob, [P('V-B', 5)])
      const seen = async (uid: string) => (await db.as(uid, 'select ref from public.installations')).map((r) => r.ref)
      expect(await seen(U.alice)).toContain(a.out.ref)
      expect(await seen(U.alice)).not.toContain(b.out.ref)
      expect(await seen(U.bob)).toContain(b.out.ref)
      expect(await seen(U.bob)).not.toContain(a.out.ref)
      expect(await seen(U.admin)).toEqual(expect.arrayContaining([a.out.ref, b.out.ref]))
      // child tables follow the parent's visibility
      expect(await db.as(U.alice, `select id from public.installation_locations where installation_id = '${b.out.installation_id}'`)).toHaveLength(0)
      expect((await db.as(U.alice, `select id from public.installation_locations where installation_id = '${a.out.installation_id}'`)).length).toBe(1)
      expect(await db.as(U.alice, `select id from public.installation_cutting_plans where installation_id = '${b.out.installation_id}'`)).toHaveLength(0)
      await db.rpc(U.admin, 'admin_update_settings', { p: { users_view_all_installations: true } })
      expect(await seen(U.alice)).toContain(b.out.ref)
      await db.rpc(U.admin, 'admin_update_settings', { p: { users_view_all_installations: false } })
    })

    it('ledger visibility: users may be allowed or denied; purchases and audit logs are admin-only', async () => {
      expect((await db.as(U.alice, 'select id from public.inventory_transactions limit 1')).length).toBe(1)
      await db.rpc(U.admin, 'admin_update_settings', { p: { users_can_view_transactions: false } })
      expect(await db.as(U.alice, 'select id from public.inventory_transactions')).toHaveLength(0)
      expect((await db.as(U.admin, 'select id from public.inventory_transactions limit 1')).length).toBe(1)
      await db.rpc(U.admin, 'admin_update_settings', { p: { users_can_view_transactions: true } })
      await db.rpc(U.admin, 'admin_record_purchase', { p: { material_id: ids['CAP-D35'], quantity: 1 } })
      expect(await db.as(U.alice, 'select id from public.purchases')).toHaveLength(0)
      expect(await db.as(U.alice, 'select id from public.audit_logs')).toHaveLength(0)
      expect((await db.as(U.admin, 'select id from public.purchases')).length).toBe(1)
      expect((await db.as(U.admin, 'select id from public.audit_logs')).length).toBeGreaterThan(3)
    })

    it('dashboard totals come from the database and ignore reversed installations', async () => {
      const dash = await db.rpc(U.alice, 'get_dashboard_summary', { p_days: 30 })
      const real = await db.admin(`select count(*)::int n, coalesce(sum(total_depth),0)::text d, coalesce(sum(location_count),0)::int l from public.installations where status = 'completed'`)
      expect(dash.installations_completed).toBe(real[0].n)
      expect(Number(dash.total_depth)).toBe(Number(real[0].d))
      expect(dash.locations_completed).toBe(real[0].l)
      const types = dash.by_type.reduce((s: number, t: any) => s + Number(t.locations), 0)
      expect(types).toBe(real[0].l)
      expect(Array.isArray(dash.consumption)).toBe(true)
      const odd = await db.rpc(U.alice, 'get_dashboard_summary', { p_days: 30, p_tz: 'Not/AZone' }) // unknown zone must not fail
      expect(odd.installations_completed).toBe(dash.installations_completed)
      // consumption chart is net of reversals: sum over days equals ledger net
      const net = await db.admin(`select coalesce(-sum(quantity),0)::text q from public.inventory_transactions where tx_type in ('installation_issue','reversal') and bucket = 'full'`)
      const chart = dash.consumption.reduce((s: number, d: any) => s + Number(d.pipes ?? 0), 0)
      expect(chart).toBe(Number(net[0].q))
    })

    it('transaction history is complete and ordered: every movement has type, material, quantity, before/after, user', async () => {
      const rows = await db.as(U.admin, 'select * from public.inventory_transactions order by created_at, tx_ref')
      expect(rows.length).toBeGreaterThan(20)
      const types = new Set(rows.map((r) => r.tx_type))
      for (const t of ['opening_stock', 'purchase', 'installation_issue', 'offcut_generated', 'offcut_consumed', 'reversal']) expect(types.has(t), t).toBe(true)
      for (const r of rows) {
        expect(r.user_id).toBeTruthy()
        expect(r.material_id).toBeTruthy()
        expect(Number(r.balance_before) + Number(r.quantity)).toBeCloseTo(Number(r.balance_after), 6)
      }
      // running balance per material/bucket is continuous (no gaps, no rewrites)
      const last = new Map<string, number>()
      for (const r of rows as Row[]) {
        const k = `${r.material_id}/${r.bucket}`
        if (last.has(k)) expect(Number(r.balance_before)).toBeCloseTo(last.get(k)!, 6)
        last.set(k, Number(r.balance_after))
      }
    })
  })
}
