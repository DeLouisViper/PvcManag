import type { InstallationType } from './engine'

export type Role = 'admin' | 'user'
export type Lang = 'vi' | 'en'
export type MaterialCategory = 'pipe' | 'screen' | 'cap'
export type Bucket = 'full' | 'offcut' | 'screen' | 'cap'
export type TxType =
  | 'opening_stock'
  | 'purchase'
  | 'installation_issue'
  | 'offcut_generated'
  | 'offcut_consumed'
  | 'adjustment'
  | 'reversal'

export interface Profile {
  id: string
  email: string
  full_name: string
  role: Role
  active: boolean
  language: Lang
  must_change_password: boolean
  created_at: string
}

export interface Material {
  id: string
  sku: string
  name: string
  name_vi: string
  diameter: 'D35' | 'D55' | 'D90'
  category: MaterialCategory
  unit: 'pcs' | 'm'
  stock_length: number | null
  low_stock_threshold: number
  sort_order: number
}

export interface SettingRow {
  key: string
  value: unknown
  description: string
  updated_at: string
}

export interface InstallationTypeRow {
  code: InstallationType
  name_en: string
  name_vi: string
  pipe_material_id: string
  screen_material_id: string | null
  cap_material_id: string
  projection_setting: string
  screen_setting: string | null
  sort_order: number
}

export interface BalanceRow {
  material_id: string
  bucket: Bucket
  quantity: number
}

export interface OffcutRow {
  id: string
  material_id: string
  length: number
  status: 'available' | 'consumed' | 'removed'
  origin: 'opening_stock' | 'installation' | 'adjustment'
  created_at: string
}

export interface LedgerRow {
  id: string
  tx_ref: string
  group_ref: string
  created_at: string
  material_id: string
  bucket: Bucket
  tx_type: TxType
  quantity: number
  unit: 'pcs' | 'm'
  balance_before: number
  balance_after: number
  offcut_id: string | null
  installation_id: string | null
  purchase_id: string | null
  user_id: string
  notes: string | null
}

export interface InventoryOverviewRow {
  material_id: string
  sku: string
  name: string
  name_vi: string
  diameter: 'D35' | 'D55' | 'D90'
  category: MaterialCategory
  unit: 'pcs' | 'm'
  stock_length: number | null
  low_stock_threshold: number
  sort_order: number
  opening: number
  purchased: number
  consumed: number
  adjusted: number
  reversed: number
  available: number
  offcut_total: number
  offcut_count: number
  last_tx_at: string | null
}

export interface InstallationRow {
  id: string
  ref: string
  project_name: string | null
  install_date: string
  notes: string | null
  status: 'completed' | 'reversed'
  transaction_ref: string
  location_count: number
  total_depth: number
  settings_snapshot: Record<string, unknown>
  calculation: Record<string, unknown>
  created_by: string
  created_at: string
  reversed_at: string | null
  reversal_reason: string | null
}

export interface InstallationLocationRow {
  id: string
  installation_id: string
  line_no: number
  installation_type: InstallationType
  location_code: string
  depth: number
  projection: number
  screen_length: number
  total_length: number
  pvc_length: number
}

export interface CuttingPlanRow {
  id: string
  installation_id: string
  location_id: string
  step_no: number
  material_id: string
  source: 'stock' | 'offcut' | 'generated'
  source_offcut_id: string | null
  source_length: number
  cut_length: number
  leftover_length: number
  kerf_length: number
  scrap_length: number
  leftover_offcut_id: string | null
}

export interface UsageRow {
  id: string
  installation_id: string
  location_id: string | null
  material_id: string
  component: 'pvc' | 'screen' | 'top_cap' | 'bottom_cap' | 'full_pipe' | 'offcut_consumed' | 'offcut_generated'
  quantity: number
  unit: 'pcs' | 'm'
  length: number | null
}

export interface DashboardSummary {
  installations_completed: number
  locations_completed: number
  total_depth: number
  by_type: { type: InstallationType; locations: number; depth: number }[]
  consumption: { day: string; pipes: number | null; screen_m: number | null; caps: number | null }[]
}

export interface Shortage {
  material_id: string
  sku: string
  name: string
  bucket: Bucket
  unit: 'pcs' | 'm'
  required: number
  available: number
  missing: number
}

export type SaveResult =
  | { ok: true; duplicate: boolean; installation_id: string; ref: string; transaction_ref: string }
  | { ok: false; error: 'INSUFFICIENT_STOCK'; shortages: Shortage[] }
  | { ok: false; error: 'STALE_PLAN'; message: string }
