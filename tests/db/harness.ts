/**
 * Database test harness.
 *  - PGlite (Postgres compiled to WASM): runs anywhere, no installation needed.
 *  - Real PostgreSQL: set TEST_DATABASE_URL (a superuser connection string) to also run the same suite
 *    against a real server and to run the true multi-connection concurrency tests.
 * Supabase pieces that exist in a real project (auth schema, auth.uid(), roles) are stubbed here.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '../../supabase/migrations')

export type Row = Record<string, any>

export interface TestDb {
  kind: 'pglite' | 'pg'
  /** superuser, autocommit (setup, direct inspection, simulating a compromised account) */
  admin(sql: string, params?: unknown[]): Promise<Row[]>
  /** run several statements (DDL scripts) */
  exec(sql: string): Promise<void>
  /** run one statement as an authenticated Supabase user, in its own transaction (like one PostgREST request) */
  as(userId: string, sql: string, params?: unknown[]): Promise<Row[]>
  /** run one statement as the anonymous role */
  anon(sql: string, params?: unknown[]): Promise<Row[]>
  /** call an RPC as a user */
  rpc(userId: string, fn: string, args?: Record<string, unknown>): Promise<any>
  close(): Promise<void>
}

const BOOTSTRAP = `
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
`

export function migrationSql(): string {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
    .join('\n')
}

function normalise(rows: Row[]): Row[] {
  return rows.map((r) => {
    const o: Row = {}
    for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v
    return o
  })
}

function rpcSql(fn: string, args: Record<string, unknown> = {}) {
  const keys = Object.keys(args)
  const call = keys.map((k, i) => `${k} => $${i + 1}${typeof args[k] === 'object' && args[k] !== null ? '::jsonb' : ''}`).join(', ')
  const params = keys.map((k) => (typeof args[k] === 'object' && args[k] !== null ? JSON.stringify(args[k]) : args[k]))
  return { sql: `select to_jsonb(public.${fn}(${call})) as result`, params }
}

export async function createPgliteDb(): Promise<TestDb> {
  const db = new PGlite()
  await db.exec(BOOTSTRAP)
  await db.exec(migrationSql())
  const run = async (role: 'authenticated' | 'anon', uid: string | null, sql: string, params?: unknown[]) =>
    db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`)
      if (uid) await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
      const r = await tx.query(sql, params as any[])
      return normalise(r.rows as Row[])
    })
  const self: TestDb = {
    kind: 'pglite',
    exec: async (sql) => {
      await db.exec(sql)
    },
    admin: async (sql, params) => normalise((await db.query(sql, params as any[])).rows as Row[]),
    as: (uid, sql, params) => run('authenticated', uid, sql, params),
    anon: (sql, params) => run('anon', null, sql, params),
    rpc: async (uid, fn, args) => {
      const { sql, params } = rpcSql(fn, args)
      const rows = await run('authenticated', uid, sql, params)
      return rows[0]?.result
    },
    close: async () => {
      await db.close()
    },
  }
  return self
}

export const REAL_PG_URL = process.env.TEST_DATABASE_URL

export async function createRealPgDb(): Promise<TestDb> {
  if (!REAL_PG_URL) throw new Error('TEST_DATABASE_URL is not set')
  const name = `haic_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const root = new pg.Client({ connectionString: REAL_PG_URL })
  await root.connect()
  await root.query(`create database ${name}`)
  await root.end()
  const url = new URL(REAL_PG_URL)
  url.pathname = '/' + name
  const pool = new pg.Pool({ connectionString: url.toString(), max: 20 })
  const setup = await pool.connect()
  await setup.query(BOOTSTRAP)
  await setup.query(migrationSql())
  setup.release()
  const run = async (role: 'authenticated' | 'anon', uid: string | null, sql: string, params?: unknown[]) => {
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query(`set local role ${role}`)
      if (uid) await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
      const r = await c.query(sql, params as any[])
      await c.query('commit')
      return normalise(r.rows)
    } catch (e) {
      await c.query('rollback').catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }
  return {
    kind: 'pg',
    exec: async (sql) => {
      await pool.query(sql)
    },
    admin: async (sql, params) => normalise((await pool.query(sql, params as any[])).rows),
    as: (uid, sql, params) => run('authenticated', uid, sql, params),
    anon: (sql, params) => run('anon', null, sql, params),
    rpc: async (uid, fn, args) => {
      const { sql, params } = rpcSql(fn, args)
      const rows = await run('authenticated', uid, sql, params)
      return rows[0]?.result
    },
    close: async () => {
      await pool.end()
      const r = new pg.Client({ connectionString: REAL_PG_URL })
      await r.connect()
      await r.query(`drop database if exists ${name} with (force)`)
      await r.end()
    },
  }
}

export const num = (v: unknown) => Number(v)
