alter table public.tests
  alter column access_code_id drop not null;

alter table public.results
  alter column access_code_id drop not null;

create or replace function public.start_public_test(
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
begin
  insert into public.tests (id, access_code_id, token_hash)
  values (p_test_id, null, p_token_hash);

  return query
    select
      p_test_id,
      null::integer,
      null::integer;
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

  if not found or v_test.access_code_id is distinct from p_access_code_id then
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

revoke all on function public.start_public_test(uuid, text)
  from public, anon, authenticated;
revoke all on function public.submit_test_result(
  uuid, uuid, uuid, text, boolean, jsonb, jsonb, numeric, text, text, jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.start_public_test(uuid, text)
  to service_role;
grant execute on function public.submit_test_result(
  uuid, uuid, uuid, text, boolean, jsonb, jsonb, numeric, text, text, jsonb, jsonb
) to service_role;
