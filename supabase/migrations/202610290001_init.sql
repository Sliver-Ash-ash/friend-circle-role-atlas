create extension if not exists pgcrypto;

create table if not exists public.code_batches (
  id uuid primary key,
  label text not null,
  item_count integer not null check (item_count between 1 and 2000),
  version integer not null default 2,
  legacy_nonce text,
  created_at timestamptz not null default now()
);

create table if not exists public.access_codes (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.code_batches(id) on delete cascade,
  batch_index integer,
  legacy_attempt integer not null default 0,
  code_lookup_hash text unique,
  legacy_lookup_hash text unique,
  max_tests integer not null default 3 check (max_tests between 1 and 20),
  used_tests integer not null default 0 check (used_tests >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (used_tests <= max_tests),
  check (batch_id is null or batch_index is not null),
  check (code_lookup_hash is not null or legacy_lookup_hash is not null)
);

create table if not exists public.tests (
  id uuid primary key,
  access_code_id uuid not null references public.access_codes(id) on delete restrict,
  token_hash text not null unique,
  status text not null default 'active'
    check (status in ('active', 'completed', 'submitting', 'abandoned')),
  answers jsonb not null default '{}'::jsonb,
  current_index integer not null default 0 check (current_index >= 0),
  result_id uuid,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.results (
  id uuid primary key,
  test_id uuid not null unique references public.tests(id) on delete restrict,
  access_code_id uuid not null references public.access_codes(id) on delete restrict,
  role_id text not null,
  is_special boolean not null default false,
  scores jsonb not null,
  target jsonb not null,
  fit_score numeric(5, 2) not null,
  secondary_role_id text,
  relation_type text,
  electricity jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.tests
  drop constraint if exists tests_result_id_fkey;

alter table public.tests
  add constraint tests_result_id_fkey
  foreign key (result_id) references public.results(id) on delete set null;

create table if not exists public.shares (
  id uuid primary key default gen_random_uuid(),
  result_id uuid not null references public.results(id) on delete cascade,
  token_hash text not null unique,
  kind text not null default 'result' check (kind in ('result', 'invite')),
  views integer not null default 0 check (views >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.rate_limit_events (
  id bigint generated always as identity primary key,
  rate_key text not null,
  created_at timestamptz not null default now()
);

create index if not exists code_batches_created_at_idx
  on public.code_batches (created_at desc);
create index if not exists access_codes_batch_id_idx
  on public.access_codes (batch_id, batch_index);
create index if not exists access_codes_legacy_hash_idx
  on public.access_codes (legacy_lookup_hash)
  where legacy_lookup_hash is not null;
create index if not exists tests_access_code_id_idx
  on public.tests (access_code_id);
create index if not exists tests_result_id_idx
  on public.tests (result_id)
  where result_id is not null;
create index if not exists shares_result_id_idx
  on public.shares (result_id);
create index if not exists rate_limit_events_lookup_idx
  on public.rate_limit_events (rate_key, created_at desc);

alter table public.code_batches enable row level security;
alter table public.access_codes enable row level security;
alter table public.tests enable row level security;
alter table public.results enable row level security;
alter table public.shares enable row level security;
alter table public.rate_limit_events enable row level security;

-- The public client never reads these tables directly. All access goes through
-- the app-api Edge Function using the service role.
revoke all on table public.code_batches from anon, authenticated;
revoke all on table public.access_codes from anon, authenticated;
revoke all on table public.tests from anon, authenticated;
revoke all on table public.results from anon, authenticated;
revoke all on table public.shares from anon, authenticated;
revoke all on table public.rate_limit_events from anon, authenticated;

create or replace function public.start_test(
  p_access_code_id uuid,
  p_test_id uuid,
  p_token_hash text
)
returns table (
  test_id uuid,
  remaining integer,
  max_tests integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code public.access_codes%rowtype;
begin
  select *
    into v_code
    from public.access_codes
   where id = p_access_code_id
   for update;

  if not found then
    raise exception using message = 'ACCESS_CODE_NOT_FOUND';
  end if;

  if v_code.used_tests >= v_code.max_tests then
    raise exception using message = 'ACCESS_EXHAUSTED';
  end if;

  update public.access_codes
     set used_tests = used_tests + 1,
         updated_at = now()
   where id = p_access_code_id;

  insert into public.tests (id, access_code_id, token_hash)
  values (p_test_id, p_access_code_id, p_token_hash);

  return query
    select
      p_test_id,
      greatest(0, v_code.max_tests - v_code.used_tests - 1),
      v_code.max_tests;
end;
$$;

create or replace function public.submit_test_result(
  p_result_id uuid,
  p_test_id uuid,
  p_access_code_id uuid,
  p_role_id text,
  p_is_special boolean,
  p_scores jsonb,
  p_target jsonb,
  p_fit_score numeric,
  p_secondary_role_id text,
  p_relation_type text,
  p_electricity jsonb,
  p_answers jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_test public.tests%rowtype;
begin
  select *
    into v_test
    from public.tests
   where id = p_test_id
   for update;

  if not found or v_test.access_code_id <> p_access_code_id then
    raise exception using message = 'TEST_NOT_FOUND';
  end if;

  if v_test.result_id is not null then
    return v_test.result_id;
  end if;

  if v_test.status <> 'active' then
    raise exception using message = 'TEST_NOT_SUBMITTABLE';
  end if;

  insert into public.results (
    id,
    test_id,
    access_code_id,
    role_id,
    is_special,
    scores,
    target,
    fit_score,
    secondary_role_id,
    relation_type,
    electricity
  )
  values (
    p_result_id,
    p_test_id,
    p_access_code_id,
    p_role_id,
    p_is_special,
    p_scores,
    p_target,
    p_fit_score,
    p_secondary_role_id,
    p_relation_type,
    p_electricity
  );

  update public.tests
     set status = 'completed',
         answers = p_answers,
         result_id = p_result_id,
         completed_at = now(),
         updated_at = now()
   where id = p_test_id;

  return p_result_id;
end;
$$;

create or replace function public.create_result_share(
  p_result_id uuid,
  p_share_token_hash text,
  p_kind text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  perform 1
    from public.results
   where id = p_result_id
   for update;

  if not found then
    raise exception using message = 'RESULT_NOT_FOUND';
  end if;

  select count(*)
    into v_count
    from public.shares
   where result_id = p_result_id;

  if v_count >= 3 then
    raise exception using message = 'SHARE_LIMIT_REACHED';
  end if;

  insert into public.shares (result_id, token_hash, kind)
  values (p_result_id, p_share_token_hash, p_kind);

  return v_count + 1;
end;
$$;

create or replace function public.check_rate_limit(
  p_rate_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_rate_key));

  delete from public.rate_limit_events
   where created_at < now() - interval '1 day';

  select count(*)
    into v_count
    from public.rate_limit_events
   where rate_key = p_rate_key
     and created_at >= now() - make_interval(secs => p_window_seconds);

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.rate_limit_events (rate_key)
  values (p_rate_key);

  return true;
end;
$$;

revoke all on function public.start_test(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.submit_test_result(
  uuid, uuid, uuid, text, boolean, jsonb, jsonb, numeric, text, text, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.create_result_share(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.check_rate_limit(text, integer, integer)
  from public, anon, authenticated;

grant execute on function public.start_test(uuid, uuid, text) to service_role;
grant execute on function public.submit_test_result(
  uuid, uuid, uuid, text, boolean, jsonb, jsonb, numeric, text, text, jsonb, jsonb
) to service_role;
grant execute on function public.create_result_share(uuid, text, text)
  to service_role;
grant execute on function public.check_rate_limit(text, integer, integer)
  to service_role;
