-- =====================================================================================
-- HAIC PVC Material Manager - 0002 secure functions
-- Every inventory change goes through these SECURITY DEFINER functions. They authenticate
-- the caller with auth.uid(), re-validate everything server-side, lock the rows they touch
-- and write the ledger in the SAME transaction (all-or-nothing).
-- =====================================================================================

-- ------------------------------------------------------------------ helpers
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = 'admin')
$$;

create or replace function public.setting_num(p_key text) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select (s.value #>> '{}')::numeric from public.material_settings s where s.key = p_key
$$;

create or replace function public.setting_bool(p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (s.value #>> '{}')::boolean from public.material_settings s where s.key = p_key
$$;

create or replace function public.can_view_transactions() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin() or (public.is_active_user() and coalesce(public.setting_bool('users_can_view_transactions'), false))
$$;

create or replace function public.can_view_installation(p_created_by uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin()
      or (public.is_active_user() and (p_created_by = auth.uid() or coalesce(public.setting_bool('users_view_all_installations'), false)))
$$;

-- deterministic remainder rule (mirrors the TypeScript engine; the database enforces it)
create or replace function public._split_remainder(
  p_source numeric, p_cut numeric, p_kerf numeric, p_min numeric,
  out kerf numeric, out leftover numeric, out scrap numeric)
language plpgsql immutable as $$
declare rem numeric; r2 numeric;
begin
  if p_cut = p_source then kerf := 0; leftover := 0; scrap := 0; return; end if;
  rem := p_source - p_cut;
  kerf := least(p_kerf, rem);
  r2 := rem - kerf;
  if r2 > 0 and r2 >= p_min then leftover := r2; scrap := 0;
  else leftover := 0; scrap := r2; end if;
end $$;

create or replace function public._audit(p_action text, p_entity text, p_entity_id text, p_details jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb))
$$;

-- The ONLY place where a balance changes. Writes the balance and its immutable ledger row together.
create or replace function public._post_ledger(
  p_group text, p_material uuid, p_bucket text, p_type public.tx_type, p_delta numeric,
  p_user uuid, p_notes text, p_offcut uuid, p_inst uuid, p_purchase uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_before numeric; v_after numeric; v_ref text; v_sku text;
begin
  if p_delta = 0 then raise exception 'VALIDATION: zero quantity movement'; end if;
  select b.quantity into v_before from public.inventory_balances b
   where b.material_id = p_material and b.bucket = p_bucket for update;
  if not found then raise exception 'VALIDATION: no % balance for this material', p_bucket; end if;
  v_after := v_before + p_delta;
  if v_after < 0 then
    select sku into v_sku from public.materials where id = p_material;
    raise exception 'NEGATIVE_STOCK: % (%) would become negative (have %, change %)', v_sku, p_bucket, v_before, p_delta
      using errcode = '23514';
  end if;
  update public.inventory_balances set quantity = v_after, updated_at = now()
   where material_id = p_material and bucket = p_bucket;
  v_ref := 'TX-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('public.inventory_tx_seq')::text, 6, '0');
  insert into public.inventory_transactions
    (tx_ref, group_ref, material_id, bucket, tx_type, quantity, unit, balance_before, balance_after,
     offcut_id, installation_id, purchase_id, user_id, notes)
  values
    (v_ref, p_group, p_material, p_bucket, p_type, p_delta,
     case when p_bucket in ('full', 'cap') then 'pcs' else 'm' end,
     v_before, v_after, p_offcut, p_inst, p_purchase, p_user, p_notes);
  return v_ref;
end $$;

create or replace function public._new_group_ref() returns text
language sql security definer set search_path = public, pg_temp as $$
  select 'TXN-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('public.txn_group_seq')::text, 6, '0')
$$;

create or replace function public._require_admin() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'FORBIDDEN: administrator rights required' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create or replace function public._lock_all_balances() returns void
language sql security definer set search_path = public, pg_temp as $$
  select 1 from public.inventory_balances order by material_id, bucket for update
$$;

-- ------------------------------------------------------------------ SAVE INSTALLATION (atomic)
-- p = {
--   client_request_id: uuid, project_name, install_date, notes,
--   locations: [{type, code, depth, screen_length|null}],
--   plan: [{step, location, source:'stock'|'offcut'|'generated', offcut_id, source_ref, source_length, cut_length, leftover_ref}]
-- }
-- The database recomputes every length, cap and screen quantity from ITS OWN settings, validates that the
-- cutting plan exactly covers each location from sources that really exist, locks the stock rows and only
-- then deducts. Quantities supplied by the browser are never trusted.
create or replace function public.save_installation(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_req uuid;
  v_exist public.installations%rowtype;
  v_stock numeric; v_kerf numeric; v_min numeric;
  v_joints boolean; v_override boolean; v_admin boolean;
  v_date date; v_project text; v_notes text;
  v_locs jsonb; v_plan jsonb;
  r record; s record; l record; o record; g record; it record; rem record; m record;
  v_code text; v_depth numeric; v_screen numeric; v_total numeric; v_idx int;
  v_group text; v_ref text; v_inst uuid; v_off uuid; v_short jsonb;
  v_calc jsonb; v_snap jsonb; v_n int; v_total_depth numeric;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'FORBIDDEN: sign in with an active account' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'VALIDATION: payload missing'; end if;

  begin
    v_req := (p ->> 'client_request_id')::uuid;
  exception when others then v_req := null; end;
  if v_req is null then raise exception 'VALIDATION: client_request_id is required'; end if;

  -- serialise identical requests, then answer a repeated one with the original result (no second deduction)
  perform pg_advisory_xact_lock(hashtextextended(v_req::text, 0));
  select * into v_exist from public.installations where client_request_id = v_req;
  if found then
    if v_exist.created_by <> v_uid then raise exception 'FORBIDDEN: request id belongs to another user' using errcode = '42501'; end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'installation_id', v_exist.id,
                              'ref', v_exist.ref, 'transaction_ref', v_exist.transaction_ref);
  end if;

  -- settings, read from the database (never from the browser)
  v_stock    := public.setting_num('pipe_stock_length');
  v_kerf     := case when public.setting_bool('cutting_allowance_enabled') then public.setting_num('cutting_allowance') else 0 end;
  v_min      := public.setting_num('min_offcut_length');
  v_joints   := public.setting_bool('allow_joints');
  v_override := public.setting_bool('allow_user_screen_override');
  v_admin    := public.is_admin();

  v_project := nullif(trim(coalesce(p ->> 'project_name', '')), '');
  v_notes   := nullif(trim(coalesce(p ->> 'notes', '')), '');
  begin
    v_date := coalesce(nullif(p ->> 'install_date', '')::date, current_date);
  exception when others then raise exception 'VALIDATION: invalid install_date'; end;
  v_locs := p -> 'locations';
  v_plan := coalesce(p -> 'plan', '[]'::jsonb);
  if v_locs is null or jsonb_typeof(v_locs) <> 'array' or jsonb_array_length(v_locs) = 0 then
    raise exception 'VALIDATION: at least one installation location is required';
  end if;
  if jsonb_array_length(v_locs) > 200 then raise exception 'VALIDATION: too many locations (max 200)'; end if;
  if jsonb_typeof(v_plan) <> 'array' or jsonb_array_length(v_plan) > 5000 then raise exception 'VALIDATION: invalid cutting plan'; end if;

  drop table if exists _loc; drop table if exists _step; drop table if exists _off;
  drop table if exists _pool; drop table if exists _req;
  create temp table _loc (
    idx int primary key, loc_id uuid not null default gen_random_uuid(), itype text not null, code text not null,
    depth numeric not null, projection numeric not null, screen numeric not null, total numeric not null, pvc numeric not null,
    pipe_mat uuid not null, screen_mat uuid, cap_mat uuid not null
  ) on commit drop;
  create temp table _step (
    step int primary key, loc_idx int not null, source text not null, offcut_id uuid, source_ref text,
    src_len numeric not null, cut numeric not null, leftover_ref text,
    pipe_mat uuid, kerf numeric, leftover numeric, scrap numeric
  ) on commit drop;
  create temp table _off (id uuid primary key, material_id uuid not null, length numeric not null, status text not null) on commit drop;
  create temp table _pool (ref text primary key, material uuid not null, len numeric not null, consumed boolean not null default false) on commit drop;
  create temp table _req (material_id uuid not null, bucket text not null, required numeric not null, primary key (material_id, bucket)) on commit drop;

  -- ---- 1. locations: recompute lengths from database settings
  for r in select t.e, (t.ord - 1)::int as idx from jsonb_array_elements(v_locs) with ordinality as t(e, ord) loop
    select i.*, public.setting_num(i.projection_setting) as proj,
           case when i.screen_setting is null then 0 else public.setting_num(i.screen_setting) end as screen_def
      into it from public.installation_types i where i.code = (r.e ->> 'type');
    if not found then raise exception 'VALIDATION: line %: unknown installation type', r.idx + 1; end if;
    v_code := trim(coalesce(r.e ->> 'code', ''));
    if v_code = '' then raise exception 'VALIDATION: line %: location identifier is required', r.idx + 1; end if;
    if r.e ->> 'depth' is null then raise exception 'VALIDATION: line % (%): depth is required', r.idx + 1, v_code; end if;
    v_depth := (r.e ->> 'depth')::numeric;
    if v_depth <= 0 then raise exception 'VALIDATION: line % (%): depth must be positive', r.idx + 1, v_code; end if;
    if v_depth <> round(v_depth, 3) then raise exception 'VALIDATION: line % (%): depth supports at most 3 decimals', r.idx + 1, v_code; end if;
    v_screen := it.screen_def;
    if it.screen_material_id is null then
      v_screen := 0;
      if r.e ->> 'screen_length' is not null and (r.e ->> 'screen_length')::numeric <> 0 then
        raise exception 'VALIDATION: line % (%): this installation type has no screen', r.idx + 1, v_code;
      end if;
    elsif r.e ->> 'screen_length' is not null then
      v_screen := (r.e ->> 'screen_length')::numeric;
      if v_screen < 0 then raise exception 'VALIDATION: line % (%): screen length cannot be negative', r.idx + 1, v_code; end if;
      if v_screen <> round(v_screen, 3) then raise exception 'VALIDATION: line % (%): screen supports at most 3 decimals', r.idx + 1, v_code; end if;
      if v_screen <> it.screen_def and not (v_override or v_admin) then
        raise exception 'FORBIDDEN: line % (%): overriding the screen length is not permitted for your account', r.idx + 1, v_code using errcode = '42501';
      end if;
    end if;
    v_total := v_depth + it.proj;
    if v_screen > v_total then
      raise exception 'VALIDATION: line % (%): screen length % m exceeds the total installed length % m', r.idx + 1, v_code, v_screen, v_total;
    end if;
    insert into _loc (idx, itype, code, depth, projection, screen, total, pvc, pipe_mat, screen_mat, cap_mat)
    values (r.idx, it.code, v_code, v_depth, it.proj, v_screen, v_total, v_total - v_screen,
            it.pipe_material_id, it.screen_material_id, it.cap_material_id);
  end loop;
  if exists (select 1 from _loc group by lower(code) having count(*) > 1) then
    raise exception 'VALIDATION: duplicate location identifiers in the same installation record';
  end if;
  select coalesce(sum(depth), 0), count(*) into v_total_depth, v_n from _loc;

  -- ---- 2. cutting plan rows
  for r in select t.e from jsonb_array_elements(v_plan) as t(e) loop
    insert into _step (step, loc_idx, source, offcut_id, source_ref, src_len, cut, leftover_ref)
    values ((r.e ->> 'step')::int, (r.e ->> 'location')::int, r.e ->> 'source',
            nullif(r.e ->> 'offcut_id', '')::uuid, nullif(r.e ->> 'source_ref', ''),
            (r.e ->> 'source_length')::numeric, (r.e ->> 'cut_length')::numeric, nullif(r.e ->> 'leftover_ref', ''));
  end loop;
  if exists (select 1 from _step where source not in ('stock', 'offcut', 'generated')) then
    raise exception 'VALIDATION: unknown cutting plan source';
  end if;
  if exists (select 1 from _step where (source = 'offcut' and offcut_id is null) or (source = 'generated' and source_ref is null)) then
    raise exception 'VALIDATION: cutting plan source reference missing';
  end if;
  if exists (select 1 from _step st left join _loc lc on lc.idx = st.loc_idx where lc.idx is null) then
    raise exception 'VALIDATION: cutting plan refers to an unknown location';
  end if;
  update _step st set pipe_mat = lc.pipe_mat from _loc lc where lc.idx = st.loc_idx;

  -- ---- 3. lock stock rows (fixed order: balances, then offcuts) so simultaneous users serialise
  perform 1 from public.inventory_balances b
   where (b.material_id, b.bucket) in (
           select pipe_mat, 'full' from _loc union select pipe_mat, 'offcut' from _loc
           union select screen_mat, 'screen' from _loc where screen_mat is not null and screen > 0
           union select cap_mat, 'cap' from _loc)
   order by b.material_id, b.bucket for update;

  perform 1 from public.pipe_offcuts po where po.id in (select offcut_id from _step where offcut_id is not null) order by po.id for update;
  insert into _off select po.id, po.material_id, po.length, po.status from public.pipe_offcuts po
   where po.id in (select offcut_id from _step where offcut_id is not null);
  if (select count(*) from _off) <> (select count(distinct offcut_id) from _step where offcut_id is not null) then
    raise exception 'VALIDATION: cutting plan refers to an unknown offcut';
  end if;
  if exists (select 1 from _off where status <> 'available') then
    return jsonb_build_object('ok', false, 'error', 'STALE_PLAN',
      'message', 'A reusable offcut in the plan is no longer available. Recalculate to use the latest inventory.');
  end if;

  -- ---- 4. replay the plan and verify every cut physically
  for s in select * from _step order by step loop
    select * into l from _loc where idx = s.loc_idx;
    if s.cut <= 0 or s.src_len <= 0 then raise exception 'VALIDATION: step %: lengths must be positive', s.step; end if;
    if s.cut > s.src_len then raise exception 'VALIDATION: step %: cut is longer than its source piece', s.step; end if;
    if s.cut <> round(s.cut, 3) or s.src_len <> round(s.src_len, 3) then raise exception 'VALIDATION: step %: lengths support at most 3 decimals', s.step; end if;

    if s.source = 'stock' then
      if s.src_len <> v_stock then raise exception 'VALIDATION: step %: a new pipe is exactly % m long', s.step, v_stock; end if;
    elsif s.source = 'offcut' then
      select * into o from _off where id = s.offcut_id;
      if o.material_id <> l.pipe_mat then raise exception 'VALIDATION: step %: offcut has a different diameter', s.step; end if;
      if o.length <> s.src_len then raise exception 'VALIDATION: step %: offcut length does not match inventory', s.step; end if;
      if exists (select 1 from _step x where x.offcut_id = s.offcut_id and x.step < s.step) then
        raise exception 'VALIDATION: step %: offcut used twice', s.step;
      end if;
    else
      select * into g from _pool where ref = s.source_ref and not consumed;
      if not found then raise exception 'VALIDATION: step %: generated leftover % does not exist or was already used', s.step, s.source_ref; end if;
      if g.material <> l.pipe_mat then raise exception 'VALIDATION: step %: leftover has a different diameter', s.step; end if;
      if g.len <> s.src_len then raise exception 'VALIDATION: step %: leftover length mismatch', s.step; end if;
      update _pool set consumed = true where ref = s.source_ref;
    end if;

    select * into rem from public._split_remainder(s.src_len, s.cut, v_kerf, v_min);
    update _step set kerf = rem.kerf, leftover = rem.leftover, scrap = rem.scrap where step = s.step;
    if rem.leftover > 0 then
      if s.leftover_ref is null then raise exception 'VALIDATION: step %: leftover reference missing', s.step; end if;
      if exists (select 1 from _pool where ref = s.leftover_ref) then raise exception 'VALIDATION: step %: duplicate leftover reference', s.step; end if;
      insert into _pool (ref, material, len) values (s.leftover_ref, l.pipe_mat, rem.leftover);
    end if;
  end loop;

  if exists (
    select 1 from _loc lc left join (select loc_idx, sum(cut) as c from _step group by loc_idx) x on x.loc_idx = lc.idx
     where coalesce(x.c, 0) <> lc.pvc) then
    raise exception 'VALIDATION: the cutting plan does not exactly cover the required PVC length of every location';
  end if;
  if not v_joints and exists (select 1 from _step group by loc_idx having count(*) > 1) then
    raise exception 'VALIDATION: joining several pipe segments is not permitted by the company settings';
  end if;

  -- ---- 5. requirements vs stock (all locked)
  insert into _req select pipe_mat, 'full', count(*) from _step where source = 'stock' group by pipe_mat;
  insert into _req select screen_mat, 'screen', sum(screen) from _loc where screen_mat is not null and screen > 0 group by screen_mat;
  insert into _req select cap_mat, 'cap', count(*) * 2 from _loc group by cap_mat;

  select jsonb_agg(jsonb_build_object(
           'material_id', q.material_id, 'sku', mt.sku, 'name', mt.name, 'bucket', q.bucket,
           'unit', case when q.bucket in ('full', 'cap') then 'pcs' else 'm' end,
           'required', q.required, 'available', b.quantity, 'missing', q.required - b.quantity))
    into v_short
    from _req q
    join public.inventory_balances b on b.material_id = q.material_id and b.bucket = q.bucket
    join public.materials mt on mt.id = q.material_id
   where q.required > b.quantity;
  if v_short is not null then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_STOCK', 'shortages', v_short);
  end if;

  -- ---- 6. write everything (any error from here rolls the whole transaction back)
  v_group := public._new_group_ref();
  v_ref := 'INS-' || to_char(v_date, 'YYMMDD') || '-' || lpad(nextval('public.installation_seq')::text, 5, '0');

  v_snap := jsonb_build_object(
    'settings', (select jsonb_object_agg(key, value) from public.material_settings),
    'installation_types', (select jsonb_agg(jsonb_build_object('code', code, 'pipe_material_id', pipe_material_id,
        'screen_material_id', screen_material_id, 'cap_material_id', cap_material_id) order by sort_order) from public.installation_types),
    'materials', (select jsonb_agg(jsonb_build_object('id', id, 'sku', sku, 'name', name, 'diameter', diameter,
        'category', category, 'stock_length', stock_length) order by sort_order) from public.materials),
    'effective', jsonb_build_object('stock_length', v_stock, 'cutting_allowance', v_kerf, 'min_offcut_length', v_min, 'allow_joints', v_joints));

  v_calc := jsonb_build_object(
    'locations', (select coalesce(jsonb_agg(jsonb_build_object('line', lc.idx + 1, 'type', lc.itype, 'code', lc.code,
        'depth', lc.depth, 'projection', lc.projection, 'screen', lc.screen, 'total', lc.total, 'pvc', lc.pvc,
        'segments', (select coalesce(jsonb_agg(st.cut order by st.step), '[]'::jsonb) from _step st where st.loc_idx = lc.idx)
      ) order by lc.idx), '[]'::jsonb) from _loc lc),
    'steps', (select coalesce(jsonb_agg(jsonb_build_object('step', st.step, 'location', st.loc_idx + 1, 'source', st.source,
        'source_length', st.src_len, 'cut', st.cut, 'leftover', st.leftover, 'kerf', st.kerf, 'scrap', st.scrap)
        order by st.step), '[]'::jsonb) from _step st),
    'pipes', (select coalesce(jsonb_agg(jsonb_build_object('sku', mt.sku,
        'required_m', (select coalesce(sum(lc.pvc), 0) from _loc lc where lc.pipe_mat = mt.id),
        'new_pipes', (select count(*) from _step st where st.pipe_mat = mt.id and st.source = 'stock'),
        'raw_new_m', (select count(*) * v_stock from _step st where st.pipe_mat = mt.id and st.source = 'stock'),
        'offcuts_consumed_m', (select coalesce(sum(st.src_len), 0) from _step st where st.pipe_mat = mt.id and st.source = 'offcut'),
        'offcuts_generated_m', (select coalesce(sum(pl.len), 0) from _pool pl where pl.material = mt.id and not pl.consumed),
        'scrap_m', (select coalesce(sum(st.scrap), 0) from _step st where st.pipe_mat = mt.id),
        'kerf_m', (select coalesce(sum(st.kerf), 0) from _step st where st.pipe_mat = mt.id)
      )), '[]'::jsonb) from public.materials mt where mt.id in (select pipe_mat from _loc)));

  insert into public.installations (ref, client_request_id, project_name, install_date, notes, transaction_ref,
                                    location_count, total_depth, settings_snapshot, calculation, created_by)
  values (v_ref, v_req, v_project, v_date, v_notes, v_group, v_n, v_total_depth, v_snap, v_calc, v_uid)
  returning id into v_inst;

  insert into public.installation_locations (id, installation_id, line_no, installation_type, location_code, depth,
                                             projection, screen_length, total_length, pvc_length)
  select loc_id, v_inst, idx + 1, itype, code, depth, projection, screen, total, pvc from _loc;

  insert into public.installation_cutting_plans (installation_id, location_id, step_no, material_id, source, source_offcut_id,
                                                 source_ref, source_length, cut_length, leftover_length, kerf_length,
                                                 scrap_length, leftover_ref)
  select v_inst, lc.loc_id, st.step, st.pipe_mat, st.source, st.offcut_id, st.source_ref, st.src_len, st.cut,
         st.leftover, st.kerf, st.scrap, case when st.leftover > 0 then st.leftover_ref end
    from _step st join _loc lc on lc.idx = st.loc_idx order by st.step;

  -- existing offcuts consumed
  for o in select f.id, f.material_id, f.length from _off f order by f.id loop
    update public.pipe_offcuts set status = 'consumed', consumed_installation_id = v_inst, consumed_at = now() where id = o.id;
    perform public._post_ledger(v_group, o.material_id, 'offcut', 'offcut_consumed', -o.length, v_uid,
                                'Reusable offcut issued to ' || v_ref, o.id, v_inst, null);
  end loop;

  -- new reusable offcuts created by this plan (individual pieces)
  for g in select * from _pool where not consumed order by ref loop
    insert into public.pipe_offcuts (material_id, length, origin, origin_installation_id, created_by)
    values (g.material, g.len, 'installation', v_inst, v_uid) returning id into v_off;
    update public.installation_cutting_plans set leftover_offcut_id = v_off
     where installation_id = v_inst and leftover_ref = g.ref;
    perform public._post_ledger(v_group, g.material, 'offcut', 'offcut_generated', g.len, v_uid,
                                'Reusable offcut generated by ' || v_ref, v_off, v_inst, null);
  end loop;

  -- full pipes, screens, caps issued
  for m in select material_id, bucket, required from _req order by material_id, bucket loop
    perform public._post_ledger(v_group, m.material_id, m.bucket, 'installation_issue', -m.required, v_uid,
                                'Issued to ' || v_ref, null, v_inst, null);
  end loop;

  -- usage lines: per location (pvc, screen, top cap, bottom cap) and per installation (pipes / offcuts)
  insert into public.installation_material_usage (installation_id, location_id, material_id, component, quantity, unit, length)
  select v_inst, loc_id, pipe_mat, 'pvc', pvc, 'm', pvc from _loc
  union all select v_inst, loc_id, screen_mat, 'screen', screen, 'm', screen from _loc where screen_mat is not null
  union all select v_inst, loc_id, cap_mat, 'top_cap', 1, 'pcs', null from _loc
  union all select v_inst, loc_id, cap_mat, 'bottom_cap', 1, 'pcs', null from _loc;
  insert into public.installation_material_usage (installation_id, location_id, material_id, component, quantity, unit, length)
  select v_inst, null::uuid, pipe_mat, 'full_pipe', count(*), 'pcs', count(*) * v_stock from _step where source = 'stock' group by pipe_mat
  union all select v_inst, null::uuid, pipe_mat, 'offcut_consumed', count(*), 'pcs', sum(src_len) from _step where source = 'offcut' group by pipe_mat
  union all select v_inst, null::uuid, material, 'offcut_generated', count(*), 'pcs', sum(len) from _pool where not consumed group by material;

  perform public._audit('installation.create', 'installations', v_inst::text,
    jsonb_build_object('ref', v_ref, 'transaction_ref', v_group, 'locations', v_n, 'total_depth', v_total_depth));

  return jsonb_build_object('ok', true, 'duplicate', false, 'installation_id', v_inst, 'ref', v_ref, 'transaction_ref', v_group);
end $$;

-- ------------------------------------------------------------------ ADMIN: opening stock
-- p_items: [{material_id, kind: 'full'|'offcut'|'screen'|'cap', quantity, length}]
--   full   : quantity = number of full pipes
--   offcut : quantity = number of pieces, length = length of EACH piece (m)
--   screen : quantity = number of pieces, length = length of EACH piece (m)
--   cap    : quantity = number of caps
create or replace function public.admin_record_opening_stock(p_items jsonb, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public._require_admin();
  v_group text; r record; m public.materials%rowtype;
  v_q numeric; v_len numeric; v_off uuid; i int; v_count int := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION: no opening stock lines supplied';
  end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'VALIDATION: too many lines (max 200)'; end if;
  perform public._lock_all_balances();
  v_group := public._new_group_ref();
  for r in select e from jsonb_array_elements(p_items) as t(e) loop
    select * into m from public.materials where id = (r.e ->> 'material_id')::uuid;
    if not found then raise exception 'VALIDATION: unknown material'; end if;
    v_q := (r.e ->> 'quantity')::numeric;
    v_len := nullif(r.e ->> 'length', '')::numeric;
    if v_q is null or v_q <= 0 or v_q <> trunc(v_q) then raise exception 'VALIDATION: % quantity must be a positive whole number', m.sku; end if;
    if v_q > 100000 then raise exception 'VALIDATION: % quantity too large', m.sku; end if;
    case r.e ->> 'kind'
      when 'full' then
        if m.category <> 'pipe' then raise exception 'VALIDATION: % is not a pipe', m.sku; end if;
        perform public._post_ledger(v_group, m.id, 'full', 'opening_stock', v_q, v_uid, p_notes, null, null, null);
        v_count := v_count + 1;
      when 'offcut' then
        if m.category <> 'pipe' then raise exception 'VALIDATION: % is not a pipe', m.sku; end if;
        if v_len is null or v_len <= 0 or v_len <> round(v_len, 3) then raise exception 'VALIDATION: % offcut length is invalid', m.sku; end if;
        if v_len >= m.stock_length then raise exception 'VALIDATION: % offcut must be shorter than a full % m pipe (record it as a full pipe)', m.sku, m.stock_length; end if;
        if v_q > 1000 then raise exception 'VALIDATION: too many offcut pieces in one line (max 1000)'; end if;
        for i in 1..v_q::int loop
          insert into public.pipe_offcuts (material_id, length, origin, created_by) values (m.id, v_len, 'opening_stock', v_uid) returning id into v_off;
          perform public._post_ledger(v_group, m.id, 'offcut', 'opening_stock', v_len, v_uid, p_notes, v_off, null, null);
          v_count := v_count + 1;
        end loop;
      when 'screen' then
        if m.category <> 'screen' then raise exception 'VALIDATION: % is not a screen', m.sku; end if;
        if v_len is null or v_len <= 0 or v_len <> round(v_len, 3) then raise exception 'VALIDATION: % piece length is invalid', m.sku; end if;
        perform public._post_ledger(v_group, m.id, 'screen', 'opening_stock', v_q * v_len, v_uid, p_notes, null, null, null);
        v_count := v_count + 1;
      when 'cap' then
        if m.category <> 'cap' then raise exception 'VALIDATION: % is not a cap', m.sku; end if;
        perform public._post_ledger(v_group, m.id, 'cap', 'opening_stock', v_q, v_uid, p_notes, null, null, null);
        v_count := v_count + 1;
      else raise exception 'VALIDATION: unknown opening stock kind';
    end case;
  end loop;
  perform public._audit('stock.opening', 'inventory_transactions', v_group, jsonb_build_object('lines', v_count, 'notes', p_notes));
  return jsonb_build_object('ok', true, 'transaction_ref', v_group, 'ledger_rows', v_count);
end $$;

-- ------------------------------------------------------------------ ADMIN: purchase
-- p = {purchase_date, supplier, material_id, quantity, total_length, reference_no, notes}
--   pipe / cap : quantity = pcs
--   screen     : quantity = pieces bought, total_length = total metres received (required)
create or replace function public.admin_record_purchase(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public._require_admin();
  v_group text; m public.materials%rowtype; v_q numeric; v_total numeric; v_id uuid; v_ref text; v_date date; v_tx text;
begin
  select * into m from public.materials where id = (p ->> 'material_id')::uuid;
  if not found then raise exception 'VALIDATION: unknown material'; end if;
  v_q := (p ->> 'quantity')::numeric;
  if v_q is null or v_q <= 0 or v_q <> trunc(v_q) then raise exception 'VALIDATION: quantity must be a positive whole number'; end if;
  v_total := nullif(p ->> 'total_length', '')::numeric;
  v_date := coalesce(nullif(p ->> 'purchase_date', '')::date, current_date);
  perform public._lock_all_balances();
  v_group := public._new_group_ref();
  v_ref := 'PUR-' || to_char(v_date, 'YYMMDD') || '-' || lpad(nextval('public.purchase_seq')::text, 5, '0');

  if m.category = 'screen' then
    if v_total is null or v_total <= 0 or v_total <> round(v_total, 3) then raise exception 'VALIDATION: total length (m) is required for screens'; end if;
  elsif m.category = 'pipe' then
    v_total := v_q * m.stock_length;
  else
    v_total := null;
  end if;

  insert into public.purchases (ref, purchase_date, supplier, material_id, quantity, unit, total_length, reference_no, notes, transaction_ref, created_by)
  values (v_ref, v_date, nullif(trim(coalesce(p ->> 'supplier', '')), ''), m.id, v_q, 'pcs', v_total,
          nullif(trim(coalesce(p ->> 'reference_no', '')), ''), nullif(trim(coalesce(p ->> 'notes', '')), ''), v_group, v_uid)
  returning id into v_id;

  if m.category = 'screen' then
    v_tx := public._post_ledger(v_group, m.id, 'screen', 'purchase', v_total, v_uid, 'Purchase ' || v_ref, null, null, v_id);
  elsif m.category = 'pipe' then
    v_tx := public._post_ledger(v_group, m.id, 'full', 'purchase', v_q, v_uid, 'Purchase ' || v_ref, null, null, v_id);
  else
    v_tx := public._post_ledger(v_group, m.id, 'cap', 'purchase', v_q, v_uid, 'Purchase ' || v_ref, null, null, v_id);
  end if;
  perform public._audit('stock.purchase', 'purchases', v_id::text, jsonb_build_object('ref', v_ref, 'sku', m.sku, 'quantity', v_q, 'total_length', v_total));
  return jsonb_build_object('ok', true, 'purchase_id', v_id, 'ref', v_ref, 'transaction_ref', v_group, 'tx_ref', v_tx);
end $$;

-- ------------------------------------------------------------------ ADMIN: documented adjustment
create or replace function public.admin_adjust_inventory(
  p_material_id uuid, p_bucket text, p_delta numeric, p_reason text,
  p_offcut_id uuid default null, p_offcut_length numeric default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public._require_admin();
  v_group text; m public.materials%rowtype; o public.pipe_offcuts%rowtype; v_off uuid; v_tx text;
begin
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'VALIDATION: a reason is required for every adjustment'; end if;
  select * into m from public.materials where id = p_material_id;
  if not found then raise exception 'VALIDATION: unknown material'; end if;
  if (m.category = 'pipe' and p_bucket not in ('full', 'offcut'))
     or (m.category = 'screen' and p_bucket <> 'screen')
     or (m.category = 'cap' and p_bucket <> 'cap') then
    raise exception 'VALIDATION: bucket % does not exist for %', p_bucket, m.sku;
  end if;
  perform public._lock_all_balances();
  v_group := public._new_group_ref();

  if p_bucket = 'offcut' then
    if p_offcut_id is not null then
      perform 1 from public.pipe_offcuts where id = p_offcut_id for update;
      select * into o from public.pipe_offcuts where id = p_offcut_id;
      if not found or o.material_id <> m.id then raise exception 'VALIDATION: offcut not found for this material'; end if;
      if o.status <> 'available' then raise exception 'VALIDATION: offcut is not available'; end if;
      update public.pipe_offcuts set status = 'removed' where id = o.id;
      v_tx := public._post_ledger(v_group, m.id, 'offcut', 'adjustment', -o.length, v_uid, p_reason, o.id, null, null);
    elsif p_offcut_length is not null and p_offcut_length > 0 then
      if p_offcut_length <> round(p_offcut_length, 3) then raise exception 'VALIDATION: offcut length supports at most 3 decimals'; end if;
      if p_offcut_length >= m.stock_length then raise exception 'VALIDATION: an offcut must be shorter than a full pipe'; end if;
      insert into public.pipe_offcuts (material_id, length, origin, created_by) values (m.id, p_offcut_length, 'adjustment', v_uid) returning id into v_off;
      v_tx := public._post_ledger(v_group, m.id, 'offcut', 'adjustment', p_offcut_length, v_uid, p_reason, v_off, null, null);
    else
      raise exception 'VALIDATION: choose an offcut to remove or give the length of an offcut to add';
    end if;
  else
    if p_delta is null or p_delta = 0 then raise exception 'VALIDATION: adjustment quantity cannot be zero'; end if;
    if p_bucket in ('full', 'cap') and p_delta <> trunc(p_delta) then raise exception 'VALIDATION: pieces must be whole numbers'; end if;
    if p_delta <> round(p_delta, 3) then raise exception 'VALIDATION: at most 3 decimals'; end if;
    v_tx := public._post_ledger(v_group, m.id, p_bucket, 'adjustment', p_delta, v_uid, p_reason, null, null, null);
  end if;
  perform public._audit('stock.adjustment', 'inventory_transactions', v_group,
    jsonb_build_object('sku', m.sku, 'bucket', p_bucket, 'delta', p_delta, 'offcut_id', p_offcut_id, 'offcut_length', p_offcut_length, 'reason', p_reason));
  return jsonb_build_object('ok', true, 'transaction_ref', v_group, 'tx_ref', v_tx);
end $$;

-- ------------------------------------------------------------------ ADMIN: reverse a saved installation
create or replace function public.admin_reverse_installation(p_installation uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public._require_admin();
  v_group text; i public.installations%rowtype; o record; m record;
begin
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'VALIDATION: a reason is required'; end if;
  perform public._lock_all_balances();
  select * into i from public.installations where id = p_installation for update;
  if not found then raise exception 'VALIDATION: installation not found'; end if;
  if i.status <> 'completed' then raise exception 'VALIDATION: installation is already reversed'; end if;
  perform 1 from public.pipe_offcuts where origin_installation_id = p_installation or consumed_installation_id = p_installation order by id for update;
  if exists (select 1 from public.pipe_offcuts where origin_installation_id = p_installation and status <> 'available') then
    raise exception 'REVERSAL_BLOCKED: offcuts created by this installation were already reused or removed - reverse the later installations first';
  end if;

  v_group := public._new_group_ref();
  -- take back the offcuts this installation generated
  for o in select id, material_id, length from public.pipe_offcuts where origin_installation_id = p_installation order by id loop
    update public.pipe_offcuts set status = 'removed' where id = o.id;
    perform public._post_ledger(v_group, o.material_id, 'offcut', 'reversal', -o.length, v_uid, 'Reversal of ' || i.ref || ': ' || p_reason, o.id, p_installation, null);
  end loop;
  -- give back the offcuts it consumed
  for o in select id, material_id, length from public.pipe_offcuts where consumed_installation_id = p_installation order by id loop
    update public.pipe_offcuts set status = 'available', consumed_installation_id = null, consumed_at = null where id = o.id;
    perform public._post_ledger(v_group, o.material_id, 'offcut', 'reversal', o.length, v_uid, 'Reversal of ' || i.ref || ': ' || p_reason, o.id, p_installation, null);
  end loop;
  -- give back full pipes, screens and caps
  for m in
    select u.material_id, case mt.category when 'pipe' then 'full' when 'screen' then 'screen' else 'cap' end as bucket,
           sum(case when u.component = 'screen' then u.quantity when u.component in ('top_cap', 'bottom_cap', 'full_pipe') then u.quantity else 0 end) as qty
      from public.installation_material_usage u join public.materials mt on mt.id = u.material_id
     where u.installation_id = p_installation and u.component in ('screen', 'top_cap', 'bottom_cap', 'full_pipe')
     group by u.material_id, mt.category order by u.material_id loop
    if m.qty > 0 then
      perform public._post_ledger(v_group, m.material_id, m.bucket, 'reversal', m.qty, v_uid, 'Reversal of ' || i.ref || ': ' || p_reason, null, p_installation, null);
    end if;
  end loop;

  update public.installations set status = 'reversed', reversed_at = now(), reversed_by = v_uid, reversal_reason = p_reason where id = p_installation;
  perform public._audit('installation.reverse', 'installations', p_installation::text, jsonb_build_object('ref', i.ref, 'reason', p_reason, 'transaction_ref', v_group));
  return jsonb_build_object('ok', true, 'transaction_ref', v_group);
end $$;

-- ------------------------------------------------------------------ ADMIN: settings, materials, profiles
create or replace function public.admin_update_settings(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public._require_admin();
  r record; v_old jsonb; v_new jsonb; v_num numeric;
  v_num_keys text[] := array['pipe_stock_length', 'projection_standard', 'projection_seismic', 'screen_default_piezometer',
                             'screen_default_permeability', 'screen_default_standpipe', 'cutting_allowance', 'min_offcut_length'];
  v_bool_keys text[] := array['cutting_allowance_enabled', 'allow_joints', 'allow_user_screen_override',
                              'users_can_view_transactions', 'users_view_all_installations'];
  v_changes jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'VALIDATION: settings payload must be an object'; end if;
  for r in select key, value from jsonb_each(p) loop
    select value into v_old from public.material_settings where key = r.key;
    if v_old is null then raise exception 'VALIDATION: unknown setting %', r.key; end if;
    if r.key = any (v_num_keys) then
      if jsonb_typeof(r.value) <> 'number' then raise exception 'VALIDATION: % must be a number', r.key; end if;
      v_num := (r.value #>> '{}')::numeric;
      if v_num < 0 or v_num <> round(v_num, 3) then raise exception 'VALIDATION: % must be >= 0 with at most 3 decimals', r.key; end if;
      if r.key = 'pipe_stock_length' and v_num <= 0 then raise exception 'VALIDATION: pipe length must be positive'; end if;
      v_new := to_jsonb(v_num);
    elsif r.key = any (v_bool_keys) then
      if jsonb_typeof(r.value) <> 'boolean' then raise exception 'VALIDATION: % must be true or false', r.key; end if;
      v_new := r.value;
    elsif r.key = 'default_language' then
      if r.value #>> '{}' not in ('vi', 'en') then raise exception 'VALIDATION: language must be vi or en'; end if;
      v_new := r.value;
    else
      raise exception 'VALIDATION: setting % cannot be changed', r.key;
    end if;
    if jsonb_typeof(v_old) = 'number' and jsonb_typeof(v_new) = 'number' then
      if (v_old #>> '{}')::numeric = (v_new #>> '{}')::numeric then continue; end if;
    elsif v_old = v_new then
      continue;
    end if;

    if r.key = 'pipe_stock_length' then
      perform public._lock_all_balances();
      if exists (select 1 from public.inventory_balances where bucket = 'full' and quantity > 0) then
        raise exception 'STOCK_LENGTH_LOCKED: full pipes are in stock, their length would silently change. Adjust the full pipes to 0 first (documented adjustment), change the length, then re-enter them.';
      end if;
      if exists (select 1 from public.pipe_offcuts where status = 'available' and length >= v_num) then
        raise exception 'STOCK_LENGTH_LOCKED: an existing offcut would be as long as a full pipe';
      end if;
      update public.materials set stock_length = v_num where category = 'pipe';
    end if;
    update public.material_settings set value = v_new, updated_by = v_uid, updated_at = now() where key = r.key;
    v_changes := v_changes || jsonb_build_object(r.key, jsonb_build_object('from', v_old, 'to', v_new));
  end loop;
  -- cross-checks on the final state
  if public.setting_num('cutting_allowance') >= public.setting_num('pipe_stock_length') then
    raise exception 'VALIDATION: cutting allowance must be smaller than the pipe length';
  end if;
  if public.setting_num('min_offcut_length') >= public.setting_num('pipe_stock_length') then
    raise exception 'VALIDATION: minimum reusable offcut must be shorter than the pipe length';
  end if;
  if v_changes <> '{}'::jsonb then
    perform public._audit('settings.update', 'material_settings', null, v_changes);
  end if;
end $$;

create or replace function public.admin_update_material(p_id uuid, p_sku text, p_name text, p_name_vi text, p_low_stock numeric) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old public.materials%rowtype;
begin
  perform public._require_admin();
  select * into v_old from public.materials where id = p_id;
  if not found then raise exception 'VALIDATION: unknown material'; end if;
  if p_sku is null or length(trim(p_sku)) = 0 or p_name is null or length(trim(p_name)) = 0 then raise exception 'VALIDATION: SKU and name are required'; end if;
  if p_low_stock is null or p_low_stock < 0 then raise exception 'VALIDATION: low-stock threshold must be >= 0'; end if;
  begin
    update public.materials set sku = trim(p_sku), name = trim(p_name), name_vi = coalesce(trim(p_name_vi), ''), low_stock_threshold = p_low_stock where id = p_id;
  exception when unique_violation then raise exception 'VALIDATION: SKU % is already used by another material', p_sku;
  end;
  perform public._audit('material.update', 'materials', p_id::text, jsonb_build_object(
    'from', jsonb_build_object('sku', v_old.sku, 'name', v_old.name, 'name_vi', v_old.name_vi, 'low_stock', v_old.low_stock_threshold),
    'to', jsonb_build_object('sku', trim(p_sku), 'name', trim(p_name), 'name_vi', p_name_vi, 'low_stock', p_low_stock)));
end $$;

create or replace function public.admin_update_profile(
  p_user uuid, p_full_name text default null, p_role public.app_role default null, p_active boolean default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.profiles%rowtype; v_role public.app_role; v_active boolean;
begin
  perform public._require_admin();
  select * into t from public.profiles where id = p_user for update;
  if not found then raise exception 'VALIDATION: user not found'; end if;
  v_role := coalesce(p_role, t.role);
  v_active := coalesce(p_active, t.active);
  if t.role = 'admin' and t.active and (v_role <> 'admin' or not v_active) then
    if not exists (select 1 from public.profiles where role = 'admin' and active and id <> p_user) then
      raise exception 'LAST_ADMIN: at least one active administrator must remain';
    end if;
  end if;
  update public.profiles set full_name = coalesce(nullif(trim(p_full_name), ''), full_name), role = v_role, active = v_active, updated_at = now() where id = p_user;
  perform public._audit('user.update', 'profiles', p_user::text, jsonb_build_object(
    'from', jsonb_build_object('role', t.role, 'active', t.active, 'full_name', t.full_name),
    'to', jsonb_build_object('role', v_role, 'active', v_active, 'full_name', coalesce(nullif(trim(p_full_name), ''), t.full_name))));
end $$;

-- ------------------------------------------------------------------ any signed-in user: own preferences only
create or replace function public.set_my_language(p_lang text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_active_user() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_lang not in ('vi', 'en') then raise exception 'VALIDATION: language must be vi or en'; end if;
  update public.profiles set language = p_lang, updated_at = now() where id = auth.uid();
end $$;

create or replace function public.mark_password_changed() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update public.profiles set must_change_password = false, updated_at = now() where id = auth.uid();
end $$;

-- ------------------------------------------------------------------ read models (aggregates, available to every active user)
create or replace function public.get_inventory_overview() returns table (
  material_id uuid, sku text, name text, name_vi text, diameter text, category public.material_category, unit text,
  stock_length numeric, low_stock_threshold numeric, sort_order int,
  opening numeric, purchased numeric, consumed numeric, adjusted numeric, reversed numeric,
  available numeric, offcut_total numeric, offcut_count int, last_tx_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_active_user() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
  select m.id, m.sku, m.name, m.name_vi, m.diameter, m.category, m.unit, m.stock_length, m.low_stock_threshold, m.sort_order,
    coalesce((select sum(t.quantity) from public.inventory_transactions t where t.material_id = m.id and t.bucket = mb.main and t.tx_type = 'opening_stock'), 0),
    coalesce((select sum(t.quantity) from public.inventory_transactions t where t.material_id = m.id and t.bucket = mb.main and t.tx_type = 'purchase'), 0),
    coalesce((select -sum(t.quantity) from public.inventory_transactions t where t.material_id = m.id and t.bucket = mb.main and t.tx_type = 'installation_issue'), 0),
    coalesce((select sum(t.quantity) from public.inventory_transactions t where t.material_id = m.id and t.bucket = mb.main and t.tx_type = 'adjustment'), 0),
    coalesce((select sum(t.quantity) from public.inventory_transactions t where t.material_id = m.id and t.bucket = mb.main and t.tx_type = 'reversal'), 0),
    coalesce((select b.quantity from public.inventory_balances b where b.material_id = m.id and b.bucket = mb.main), 0),
    coalesce((select b.quantity from public.inventory_balances b where b.material_id = m.id and b.bucket = 'offcut'), 0),
    (select count(*)::int from public.pipe_offcuts o where o.material_id = m.id and o.status = 'available'),
    (select max(t.created_at) from public.inventory_transactions t where t.material_id = m.id)
  from public.materials m
  cross join lateral (select case m.category when 'pipe' then 'full' when 'screen' then 'screen' else 'cap' end as main) mb
  order by m.sort_order;
end $$;

create or replace function public.get_dashboard_summary(p_days int default 30, p_tz text default 'Asia/Ho_Chi_Minh') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_since timestamptz; v_res jsonb;
begin
  if not public.is_active_user() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  p_days := greatest(1, least(coalesce(p_days, 30), 365));
  -- browsers may send legacy zone aliases (e.g. Asia/Saigon) that a server does not know: fall back to UTC instead of failing
  begin
    perform now() at time zone p_tz;
  exception when others then
    p_tz := 'UTC';
  end;
  v_since := now() - make_interval(days => p_days);
  select jsonb_build_object(
    'installations_completed', (select count(*) from public.installations where status = 'completed'),
    'locations_completed', (select coalesce(sum(location_count), 0) from public.installations where status = 'completed'),
    'total_depth', (select coalesce(sum(total_depth), 0) from public.installations where status = 'completed'),
    'by_type', (select coalesce(jsonb_agg(jsonb_build_object('type', x.t, 'locations', x.n, 'depth', x.d) order by x.t), '[]'::jsonb)
                from (select l.installation_type as t, count(*) as n, sum(l.depth) as d
                        from public.installation_locations l join public.installations i on i.id = l.installation_id
                       where i.status = 'completed' and i.created_at >= v_since group by l.installation_type) x),
    'consumption', (select coalesce(jsonb_agg(jsonb_build_object('day', x.day, 'pipes', x.pipes, 'screen_m', x.screen, 'caps', x.caps) order by x.day), '[]'::jsonb)
                from (select (t.created_at at time zone p_tz)::date as day,
                             -sum(t.quantity) filter (where t.bucket = 'full') as pipes,
                             -sum(t.quantity) filter (where t.bucket = 'screen') as screen,
                             -sum(t.quantity) filter (where t.bucket = 'cap') as caps
                        from public.inventory_transactions t
                       where t.tx_type in ('installation_issue', 'reversal') and t.bucket in ('full', 'screen', 'cap') and t.created_at >= v_since
                       group by 1) x)
  ) into v_res;
  return v_res;
end $$;

-- ledger integrity check: balances must equal the sum of the immutable ledger, and offcut totals the sum of available pieces
create or replace function public.verify_inventory_integrity() returns table (
  material_id uuid, sku text, bucket text, balance numeric, ledger_sum numeric, pieces_sum numeric, ok boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_active_user() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
  select b.material_id, m.sku, b.bucket, b.quantity,
         coalesce((select sum(t.quantity) from public.inventory_transactions t where t.material_id = b.material_id and t.bucket = b.bucket), 0),
         case when b.bucket = 'offcut' then coalesce((select sum(o.length) from public.pipe_offcuts o where o.material_id = b.material_id and o.status = 'available'), 0) end,
         b.quantity = coalesce((select sum(t.quantity) from public.inventory_transactions t where t.material_id = b.material_id and t.bucket = b.bucket), 0)
           and (b.bucket <> 'offcut' or b.quantity = coalesce((select sum(o.length) from public.pipe_offcuts o where o.material_id = b.material_id and o.status = 'available'), 0))
    from public.inventory_balances b join public.materials m on m.id = b.material_id
   order by m.sort_order, b.bucket;
end $$;
