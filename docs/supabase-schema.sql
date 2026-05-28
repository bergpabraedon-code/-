create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  id text primary key,
  service_name text not null default 'ai图片精灵',
  service_status text not null default '统一账号登录后使用，平台已托管固定生图 API。',
  points_per_generation integer not null default 12 check (points_per_generation > 0),
  signup_bonus_points integer not null default 120 check (signup_bonus_points >= 0),
  upstream_channel_label text not null default 'banana Pro 官转',
  upstream_protocol text not null default 'custom-openai',
  upstream_base_url text not null default '',
  upstream_api_key text not null default '',
  upstream_default_model text not null default 'gpt-image-2',
  upstream_analysis_model text not null default 'gpt-5.4',
  updated_at timestamptz not null default now()
);

insert into public.app_settings (
  id,
  service_name,
  service_status,
  points_per_generation,
  signup_bonus_points,
  upstream_channel_label,
  upstream_protocol,
  upstream_base_url,
  upstream_api_key,
  upstream_default_model,
  upstream_analysis_model
)
values (
  'default',
  'ai图片精灵',
  '统一账号登录后使用，平台已托管固定生图 API。',
  12,
  120,
  'banana Pro 官转',
  'custom-openai',
  '',
  '',
  'gpt-image-2',
  'gpt-5.4'
)
on conflict (id) do nothing;

alter table public.app_settings
  add column if not exists upstream_channel_label text not null default 'banana Pro 官转',
  add column if not exists upstream_protocol text not null default 'custom-openai',
  add column if not exists upstream_base_url text not null default '',
  add column if not exists upstream_api_key text not null default '',
  add column if not exists upstream_default_model text not null default 'gpt-image-2',
  add column if not exists upstream_analysis_model text not null default 'gpt-5.4';

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.point_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.point_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  delta integer not null,
  balance_after integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

drop trigger if exists trg_point_accounts_updated_at on public.point_accounts;
create trigger trg_point_accounts_updated_at
before update on public.point_accounts
for each row
execute function public.set_updated_at();

drop trigger if exists trg_app_settings_updated_at on public.app_settings;
create trigger trg_app_settings_updated_at
before update on public.app_settings
for each row
execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  signup_bonus integer;
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do update
  set email = excluded.email;

  insert into public.point_accounts (user_id, balance)
  values (new.id, 0)
  on conflict (user_id) do nothing;

  select signup_bonus_points
  into signup_bonus
  from public.app_settings
  where id = 'default';

  if coalesce(signup_bonus, 0) > 0 then
    update public.point_accounts
    set balance = balance + signup_bonus
    where user_id = new.id;

    insert into public.point_ledger (user_id, delta, balance_after, reason)
    select new.id, signup_bonus, balance, 'signup_bonus'
    from public.point_accounts
    where user_id = new.id;
  end if;

  return new;
end;
$$;

create or replace function public.ensure_platform_user(p_email text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_email text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  resolved_email := nullif(coalesce(p_email, ''), '');
  if resolved_email is null then
    resolved_email := nullif(coalesce(auth.jwt() ->> 'email', ''), '');
  end if;

  if resolved_email is null then
    raise exception 'email_missing';
  end if;

  insert into public.profiles (id, email)
  values (auth.uid(), resolved_email)
  on conflict (id) do update
  set email = excluded.email;

  insert into public.point_accounts (user_id, balance)
  values (auth.uid(), 0)
  on conflict (user_id) do nothing;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_auth_user();

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_admin = true
  );
$$;

create or replace function public.consume_generation_points(p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance integer;
  next_balance integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;

  select balance
  into current_balance
  from public.point_accounts
  where user_id = auth.uid()
  for update;

  if current_balance is null then
    raise exception 'point_account_missing';
  end if;

  if current_balance < p_amount then
    raise exception 'insufficient_points';
  end if;

  next_balance := current_balance - p_amount;

  update public.point_accounts
  set balance = next_balance
  where user_id = auth.uid();

  insert into public.point_ledger (user_id, delta, balance_after, reason)
  values (auth.uid(), -p_amount, next_balance, 'generation');

  return next_balance;
end;
$$;

create or replace function public.refund_generation_points(p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  next_balance integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;

  update public.point_accounts
  set balance = balance + p_amount
  where user_id = auth.uid()
  returning balance into next_balance;

  if next_balance is null then
    raise exception 'point_account_missing';
  end if;

  insert into public.point_ledger (user_id, delta, balance_after, reason)
  values (auth.uid(), p_amount, next_balance, 'generation_refund');

  return next_balance;
end;
$$;

create or replace function public.admin_adjust_points(
  target_user_id uuid,
  delta_amount integer,
  reason_text text default 'admin_adjustment'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance integer;
  next_balance integer;
begin
  if not public.is_platform_admin() then
    raise exception 'admin_required';
  end if;

  if target_user_id is null or delta_amount is null or delta_amount = 0 then
    raise exception 'invalid_adjustment';
  end if;

  select balance
  into current_balance
  from public.point_accounts
  where user_id = target_user_id
  for update;

  if current_balance is null then
    raise exception 'point_account_missing';
  end if;

  next_balance := greatest(current_balance + delta_amount, 0);

  update public.point_accounts
  set balance = next_balance
  where user_id = target_user_id;

  insert into public.point_ledger (user_id, delta, balance_after, reason)
  values (target_user_id, next_balance - current_balance, next_balance, reason_text);

  return next_balance;
end;
$$;

alter table public.app_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.point_accounts enable row level security;
alter table public.point_ledger enable row level security;

drop policy if exists "authenticated_read_settings" on public.app_settings;
create policy "authenticated_read_settings"
on public.app_settings
for select
to authenticated
using (true);

drop policy if exists "admin_manage_settings" on public.app_settings;
create policy "admin_manage_settings"
on public.app_settings
for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

drop policy if exists "users_read_own_profile" on public.profiles;
create policy "users_read_own_profile"
on public.profiles
for select
to authenticated
using (auth.uid() = id or public.is_platform_admin());

drop policy if exists "users_update_own_profile" on public.profiles;
create policy "users_update_own_profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id or public.is_platform_admin())
with check (auth.uid() = id or public.is_platform_admin());

drop policy if exists "admins_insert_profiles" on public.profiles;
create policy "admins_insert_profiles"
on public.profiles
for insert
to authenticated
with check (public.is_platform_admin());

drop policy if exists "users_read_point_accounts" on public.point_accounts;
create policy "users_read_point_accounts"
on public.point_accounts
for select
to authenticated
using (auth.uid() = user_id or public.is_platform_admin());

drop policy if exists "admins_manage_point_accounts" on public.point_accounts;
create policy "admins_manage_point_accounts"
on public.point_accounts
for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

drop policy if exists "users_read_point_ledger" on public.point_ledger;
create policy "users_read_point_ledger"
on public.point_ledger
for select
to authenticated
using (auth.uid() = user_id or public.is_platform_admin());

grant usage on schema public to anon, authenticated;
grant select on public.app_settings to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.point_accounts to authenticated;
grant select on public.point_ledger to authenticated;
grant execute on function public.ensure_platform_user(text) to authenticated;
grant execute on function public.consume_generation_points(integer) to authenticated;
grant execute on function public.refund_generation_points(integer) to authenticated;
grant execute on function public.admin_adjust_points(uuid, integer, text) to authenticated;
grant execute on function public.is_platform_admin() to authenticated;

-- 首次创建完账号后，在 SQL Editor 手动把你的运营账号设成管理员：
-- update public.profiles set is_admin = true where email = '461059476@qq.com';
