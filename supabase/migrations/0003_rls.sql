-- =====================================================================================
-- HAIC PVC Material Manager - 0003 Row Level Security and privileges
-- Browser clients (role "authenticated") can only READ, and only what the policies allow.
-- Every write goes through the SECURITY DEFINER functions in 0002. Anonymous users get nothing.
-- =====================================================================================

alter table public.profiles                    enable row level security;
alter table public.materials                   enable row level security;
alter table public.material_settings           enable row level security;
alter table public.installation_types          enable row level security;
alter table public.inventory_balances          enable row level security;
alter table public.pipe_offcuts                enable row level security;
alter table public.purchases                   enable row level security;
alter table public.installations               enable row level security;
alter table public.installation_locations      enable row level security;
alter table public.installation_cutting_plans  enable row level security;
alter table public.installation_material_usage enable row level security;
alter table public.inventory_transactions      enable row level security;
alter table public.audit_logs                  enable row level security;

-- start from zero privileges, then grant read access only
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant usage on schema public to anon, authenticated;

grant select on
  public.profiles, public.materials, public.material_settings, public.installation_types,
  public.inventory_balances, public.pipe_offcuts, public.purchases, public.installations,
  public.installation_locations, public.installation_cutting_plans, public.installation_material_usage,
  public.inventory_transactions, public.audit_logs
to authenticated;

-- a user can always read their own profile (so a disabled account can be told why);
-- active users can read the staff list (names shown next to records)
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active_user());

create policy materials_select on public.materials for select to authenticated using (public.is_active_user());
create policy material_settings_select on public.material_settings for select to authenticated using (public.is_active_user());
create policy installation_types_select on public.installation_types for select to authenticated using (public.is_active_user());
create policy inventory_balances_select on public.inventory_balances for select to authenticated using (public.is_active_user());
create policy pipe_offcuts_select on public.pipe_offcuts for select to authenticated using (public.is_active_user());

-- admins see everything; standard users see their own records, or all when the company allows it
create policy installations_select on public.installations for select to authenticated
  using (public.can_view_installation(created_by));
create policy installation_locations_select on public.installation_locations for select to authenticated
  using (exists (select 1 from public.installations i where i.id = installation_id));
create policy installation_cutting_plans_select on public.installation_cutting_plans for select to authenticated
  using (exists (select 1 from public.installations i where i.id = installation_id));
create policy installation_material_usage_select on public.installation_material_usage for select to authenticated
  using (exists (select 1 from public.installations i where i.id = installation_id));

create policy inventory_transactions_select on public.inventory_transactions for select to authenticated
  using (public.can_view_transactions());
create policy purchases_select on public.purchases for select to authenticated using (public.is_admin());
create policy audit_logs_select on public.audit_logs for select to authenticated using (public.is_admin());

-- NO insert / update / delete policies exist for any table: direct writes are impossible for browser clients.

-- functions the browser may call (all re-check the caller internally)
grant execute on function
  public.is_active_user(), public.is_admin(), public.setting_num(text), public.setting_bool(text),
  public.can_view_transactions(), public.can_view_installation(uuid),
  public.save_installation(jsonb),
  public.admin_record_opening_stock(jsonb, text),
  public.admin_record_purchase(jsonb),
  public.admin_adjust_inventory(uuid, text, numeric, text, uuid, numeric),
  public.admin_reverse_installation(uuid, text),
  public.admin_update_settings(jsonb),
  public.admin_update_material(uuid, text, text, text, numeric),
  public.admin_update_profile(uuid, text, public.app_role, boolean),
  public.set_my_language(text), public.mark_password_changed(),
  public.get_inventory_overview(), public.get_dashboard_summary(int, text), public.verify_inventory_integrity()
to authenticated;
-- internal helpers (_post_ledger, _audit, _split_remainder, ...) stay private to the function owner.

-- the service role (Edge Function for user creation) keeps full access
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
