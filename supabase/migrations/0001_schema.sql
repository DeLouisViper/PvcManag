-- =====================================================================================
-- HAIC PVC Material Manager - 0001 schema
-- Tables, constraints, indexes, immutability triggers and seed master data.
-- Lengths are metres stored as numeric(10,3) (millimetre precision, never floating point).
-- =====================================================================================

create type public.app_role as enum ('admin', 'user');
create type public.material_category as enum ('pipe', 'screen', 'cap');
create type public.tx_type as enum (
  'opening_stock', 'purchase', 'installation_issue',
  'offcut_generated', 'offcut_consumed', 'adjustment', 'reversal'
);

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  role public.app_role not null default 'user',
  active boolean not null default true,
  language text not null default 'vi' check (language in ('vi', 'en')),
  must_change_password boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A profile is created automatically for every auth user. The role is ALWAYS 'user' and the account starts INACTIVE:
-- even if public sign-up were left enabled by mistake, a stranger could see and do nothing until an admin activates the account.
-- The role is ALWAYS 'user' here:
-- user-editable metadata is never trusted. Admins are promoted only by an existing admin
-- (admin_update_profile) or by the one-off bootstrap SQL in the README.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, email, full_name, active)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)), false)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- materials
create table public.materials (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique check (length(trim(sku)) > 0),
  name text not null check (length(trim(name)) > 0),
  name_vi text not null default '',
  diameter text not null check (diameter in ('D35', 'D55', 'D90')),
  category public.material_category not null,
  unit text not null check (unit in ('pcs', 'm')),
  -- standard stock length of one new pipe (metres) - pipes only
  stock_length numeric(10, 3) check (stock_length is null or stock_length > 0),
  low_stock_threshold numeric(14, 3) not null default 0 check (low_stock_threshold >= 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  check ((category = 'pipe') = (stock_length is not null)),
  check ((category = 'screen' and unit = 'm') or (category <> 'screen' and unit = 'pcs'))
);

-- Key/value application settings (numbers, booleans, text)
create table public.material_settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

-- Which materials an installation type uses
create table public.installation_types (
  code text primary key check (code in ('piezometer', 'standpipe', 'permeability', 'seismic')),
  name_en text not null,
  name_vi text not null,
  pipe_material_id uuid not null references public.materials (id),
  screen_material_id uuid references public.materials (id),  -- null: no screen material (Seismic)
  cap_material_id uuid not null references public.materials (id),
  projection_setting text not null references public.material_settings (key),
  screen_setting text references public.material_settings (key),
  sort_order int not null default 0
);

-- ---------------------------------------------------------------- inventory
-- Current balance per material and bucket. Only secure functions change it, always together with a ledger row.
--   full   : number of full standard-length pipes          (pcs)
--   offcut : total length of reusable pipe offcuts          (m)   - individual pieces live in pipe_offcuts
--   screen : screen / filter pipe stock                     (m)
--   cap    : caps                                           (pcs)
create table public.inventory_balances (
  material_id uuid not null references public.materials (id),
  bucket text not null check (bucket in ('full', 'offcut', 'screen', 'cap')),
  quantity numeric(14, 3) not null default 0 check (quantity >= 0),   -- inventory can never go negative
  updated_at timestamptz not null default now(),
  primary key (material_id, bucket)
);

create table public.pipe_offcuts (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials (id),
  length numeric(10, 3) not null check (length > 0),
  status text not null default 'available' check (status in ('available', 'consumed', 'removed')),
  origin text not null check (origin in ('opening_stock', 'installation', 'adjustment')),
  origin_installation_id uuid,
  consumed_installation_id uuid,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index pipe_offcuts_available_idx on public.pipe_offcuts (material_id, length) where status = 'available';

-- ---------------------------------------------------------------- purchases
create sequence public.txn_group_seq;
create sequence public.inventory_tx_seq;
create sequence public.installation_seq;
create sequence public.purchase_seq;

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  purchase_date date not null,
  supplier text,
  material_id uuid not null references public.materials (id),
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null,
  total_length numeric(14, 3),
  reference_no text,
  notes text,
  transaction_ref text not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- installations
create table public.installations (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  client_request_id uuid not null unique,         -- idempotency key: a double submit can never deduct twice
  project_name text,
  install_date date not null,
  notes text,
  status text not null default 'completed' check (status in ('completed', 'reversed')),
  transaction_ref text not null,
  location_count int not null check (location_count > 0),
  total_depth numeric(12, 3) not null check (total_depth > 0),
  settings_snapshot jsonb not null,               -- settings in force when the record was saved (reproducible history)
  calculation jsonb not null,                     -- server-side recalculation result
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references public.profiles (id),
  reversal_reason text
);
create index installations_created_at_idx on public.installations (created_at desc);
create index installations_created_by_idx on public.installations (created_by);

create table public.installation_locations (
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null references public.installations (id),
  line_no int not null,
  installation_type text not null references public.installation_types (code),
  location_code text not null check (length(trim(location_code)) > 0),
  depth numeric(10, 3) not null check (depth > 0),
  projection numeric(10, 3) not null check (projection >= 0),
  screen_length numeric(10, 3) not null check (screen_length >= 0),
  total_length numeric(10, 3) not null,
  pvc_length numeric(10, 3) not null check (pvc_length >= 0),
  check (total_length = depth + projection),
  check (pvc_length = total_length - screen_length),
  check (screen_length <= total_length)
);
create unique index installation_locations_code_uq on public.installation_locations (installation_id, lower(trim(location_code)));
create index installation_locations_inst_idx on public.installation_locations (installation_id);

create table public.installation_cutting_plans (
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null references public.installations (id),
  location_id uuid not null references public.installation_locations (id),
  step_no int not null,
  material_id uuid not null references public.materials (id),
  source text not null check (source in ('stock', 'offcut', 'generated')),
  source_offcut_id uuid references public.pipe_offcuts (id),
  source_ref text,
  source_length numeric(10, 3) not null check (source_length > 0),
  cut_length numeric(10, 3) not null check (cut_length > 0),
  leftover_length numeric(10, 3) not null check (leftover_length >= 0),
  kerf_length numeric(10, 3) not null check (kerf_length >= 0),
  scrap_length numeric(10, 3) not null check (scrap_length >= 0),
  leftover_ref text,
  leftover_offcut_id uuid references public.pipe_offcuts (id),
  check (cut_length <= source_length),
  check (cut_length + leftover_length + kerf_length + scrap_length = source_length),
  unique (installation_id, step_no)
);
create index installation_cutting_plans_inst_idx on public.installation_cutting_plans (installation_id);

create table public.installation_material_usage (
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null references public.installations (id),
  location_id uuid references public.installation_locations (id),   -- null = whole-installation line
  material_id uuid not null references public.materials (id),
  component text not null check (component in (
    'pvc', 'screen', 'top_cap', 'bottom_cap',             -- per location
    'full_pipe', 'offcut_consumed', 'offcut_generated'    -- per installation and material
  )),
  quantity numeric(14, 3) not null check (quantity >= 0),
  unit text not null check (unit in ('pcs', 'm')),
  length numeric(14, 3)
);
create index installation_material_usage_inst_idx on public.installation_material_usage (installation_id);

-- ---------------------------------------------------------------- ledger + audit
create table public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  tx_ref text not null unique,
  group_ref text not null,                          -- groups all rows of one business operation
  created_at timestamptz not null default now(),
  material_id uuid not null references public.materials (id),
  bucket text not null check (bucket in ('full', 'offcut', 'screen', 'cap')),
  tx_type public.tx_type not null,
  quantity numeric(14, 3) not null check (quantity <> 0),   -- signed: + increases stock, - decreases stock
  unit text not null check (unit in ('pcs', 'm')),
  balance_before numeric(14, 3) not null check (balance_before >= 0),
  balance_after numeric(14, 3) not null check (balance_after >= 0),
  offcut_id uuid references public.pipe_offcuts (id),
  installation_id uuid references public.installations (id),
  purchase_id uuid references public.purchases (id),
  user_id uuid not null references public.profiles (id),
  notes text,
  check (balance_after = balance_before + quantity)
);
create index inventory_transactions_created_idx on public.inventory_transactions (created_at desc);
create index inventory_transactions_material_idx on public.inventory_transactions (material_id, bucket, created_at desc);
create index inventory_transactions_group_idx on public.inventory_transactions (group_ref);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid references public.profiles (id),
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

-- ---------------------------------------------------------------- immutability
create or replace function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE: % rows cannot be updated or deleted (use a reversal or adjustment transaction)', tg_table_name
    using errcode = '42501';
end $$;

create trigger inventory_transactions_immutable before update or delete on public.inventory_transactions
  for each row execute function public.forbid_mutation();
create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.forbid_mutation();
create trigger installation_locations_immutable before update or delete on public.installation_locations
  for each row execute function public.forbid_mutation();
create trigger installation_material_usage_immutable before update or delete on public.installation_material_usage
  for each row execute function public.forbid_mutation();
create trigger purchases_immutable before update or delete on public.purchases
  for each row execute function public.forbid_mutation();

-- cutting plan rows may only gain their leftover_offcut_id link during the saving transaction
create or replace function public.cutting_plan_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: installation_cutting_plans rows cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(old) - 'leftover_offcut_id') is distinct from (to_jsonb(new) - 'leftover_offcut_id')
     or old.leftover_offcut_id is not null then
    raise exception 'IMMUTABLE: installation_cutting_plans rows cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger installation_cutting_plans_guard before update or delete on public.installation_cutting_plans
  for each row execute function public.cutting_plan_guard();

-- installations: only the reversal columns may ever change; never deleted
create or replace function public.installation_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: installations cannot be deleted (reverse them instead)' using errcode = '42501';
  end if;
  if (to_jsonb(old) - 'status' - 'reversed_at' - 'reversed_by' - 'reversal_reason')
     is distinct from (to_jsonb(new) - 'status' - 'reversed_at' - 'reversed_by' - 'reversal_reason') then
    raise exception 'IMMUTABLE: a saved installation cannot be edited' using errcode = '42501';
  end if;
  if old.status = 'reversed' then
    raise exception 'IMMUTABLE: installation already reversed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger installations_guard before update or delete on public.installations
  for each row execute function public.installation_guard();

-- ================================================================= seed master data
insert into public.material_settings (key, value, description) values
  ('pipe_stock_length',              '4',     'Standard length of one new PVC pipe (m)'),
  ('projection_standard',            '1',     'Above-ground projection for Piezometer, Permeability and Standpipe (m)'),
  ('projection_seismic',             '0.5',   'Above-ground projection for Seismic (m)'),
  ('screen_default_piezometer',      '1',     'Default screen length per Piezometer location (m)'),
  ('screen_default_permeability',    '1',     'Default screen length per Permeability location (m)'),
  ('screen_default_standpipe',       '5',     'Default screen length per Standpipe location (m)'),
  ('cutting_allowance_enabled',      'false', 'Apply a cutting allowance (kerf) to every saw cut'),
  ('cutting_allowance',              '0',     'Cutting allowance per saw cut (m) - used only when enabled'),
  ('min_offcut_length',              '0.1',   'Remainders shorter than this (m) are scrap, not reusable offcuts'),
  ('allow_joints',                   'true',  'Allow several PVC segments to be joined to reach the required length'),
  ('allow_user_screen_override',     'true',  'Standard users may override the screen length of a location'),
  ('users_can_view_transactions',    'true',  'Standard users may view the stock transaction ledger'),
  ('users_view_all_installations',   'false', 'Standard users may view installations created by other users'),
  ('default_language',               '"vi"',  'Default interface language (vi or en)');

with m as (
  insert into public.materials (sku, name, name_vi, diameter, category, unit, stock_length, low_stock_threshold, sort_order) values
    ('PVC-D35',  'PVC Pipe D35',   'Ống PVC D35',   'D35', 'pipe',   'pcs', 4,    10, 10),
    ('PVC-D55',  'PVC Pipe D55',   'Ống PVC D55',   'D55', 'pipe',   'pcs', 4,    10, 20),
    ('PVC-D90',  'PVC Pipe D90',   'Ống PVC D90',   'D90', 'pipe',   'pcs', 4,    10, 30),
    ('SCR-D35',  'Screen D35',     'Ống lọc D35',   'D35', 'screen', 'm',   null, 10, 40),
    ('SCR-D55',  'Screen D55',     'Ống lọc D55',   'D55', 'screen', 'm',   null, 20, 50),
    ('CAP-D35',  'PVC Cap D35',    'Nắp PVC D35',   'D35', 'cap',    'pcs', null, 10, 60),
    ('CAP-D55',  'PVC Cap D55',    'Nắp PVC D55',   'D55', 'cap',    'pcs', null, 10, 70),
    ('CAP-D90',  'PVC Cap D90',    'Nắp PVC D90',   'D90', 'cap',    'pcs', null, 10, 80)
  returning id, sku, category
)
insert into public.inventory_balances (material_id, bucket)
select id, 'full' from m where category = 'pipe'
union all select id, 'offcut' from m where category = 'pipe'
union all select id, 'screen' from m where category = 'screen'
union all select id, 'cap' from m where category = 'cap';

insert into public.installation_types (code, name_en, name_vi, pipe_material_id, screen_material_id, cap_material_id, projection_setting, screen_setting, sort_order)
select t.code, t.name_en, t.name_vi,
       (select id from public.materials where sku = t.pipe_sku),
       (select id from public.materials where sku = t.screen_sku),
       (select id from public.materials where sku = t.cap_sku),
       t.projection_setting, t.screen_setting, t.sort_order
from (values
  ('piezometer',   'Piezometer',   'Ống đo áp lực nước lỗ rỗng / Piezometer', 'PVC-D35', 'SCR-D35', 'CAP-D35', 'projection_standard', 'screen_default_piezometer',   1),
  ('standpipe',    'Standpipe',    'Ống Standpipe',                           'PVC-D55', 'SCR-D55', 'CAP-D55', 'projection_standard', 'screen_default_standpipe',    2),
  ('permeability', 'Permeability', 'Ống thí nghiệm thấm',                     'PVC-D35', 'SCR-D35', 'CAP-D35', 'projection_standard', 'screen_default_permeability', 3),
  ('seismic',      'Seismic',      'Ống đo địa chấn',                         'PVC-D90', null,      'CAP-D90', 'projection_seismic',  null,                          4)
) as t(code, name_en, name_vi, pipe_sku, screen_sku, cap_sku, projection_setting, screen_setting, sort_order);
