-- Adversarial RLS test. Runs entirely in one transaction, then rolls back.
-- Proves: cross-org isolation, trace immutability, correction author-gating,
-- and create_org auth requirement. Any failure RAISEs and ON_ERROR_STOP aborts.
\set ON_ERROR_STOP on
begin;

do $$
declare
  user_a uuid := '00000000-0000-0000-0000-00000000000a';
  user_b uuid := '00000000-0000-0000-0000-00000000000b';
  org_a  uuid;
  org_b  uuid;
  trace_a uuid;
  trace_b uuid;
  n int;
  ok boolean;
begin
  -- ---- privileged setup (superuser) ---------------------------------------
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (user_a, 'authenticated', 'authenticated', 'a@acme.test', now(), now()),
         (user_b, 'authenticated', 'authenticated', 'b@beta.test', now(), now());

  -- profiles trigger should have mirrored both users
  select count(*) into n from public.profiles where id in (user_a, user_b);
  if n <> 2 then raise exception 'FAIL: signup trigger did not create 2 profiles (got %)', n; end if;
  raise notice 'PASS: signup trigger mirrored profiles';

  -- create orgs via the definer RPC, each impersonated by its owner
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  select id into org_a from public.create_org('Acme');

  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);
  select id into org_b from public.create_org('Beta');
  raise notice 'PASS: create_org made org_a=% org_b=%', org_a, org_b;

  -- membership created atomically as owner?
  select count(*) into n from public.org_members where org_id = org_a and user_id = user_a and role = 'owner';
  if n <> 1 then raise exception 'FAIL: create_org did not add owner membership'; end if;
  raise notice 'PASS: create_org added owner membership atomically';

  -- traces written as service role (bypass) — one per org
  perform set_config('request.jwt.claims', '', true);
  insert into public.traces (org_id, model, prompt_messages, output)
  values (org_a, 'claude-sonnet-5', '[{"role":"user","content":"hi from acme"}]', 'acme out')
  returning id into trace_a;
  insert into public.traces (org_id, model, prompt_messages, output)
  values (org_b, 'gpt-4o', '[{"role":"user","content":"hi from beta"}]', 'beta out')
  returning id into trace_b;

  -- ---- switch to a non-superuser; RLS now applies -------------------------
  set local role authenticated;

  -- === USER A ===
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  select count(*) into n from public.traces;
  if n <> 1 then raise exception 'FAIL: user A sees % traces, expected 1 (own org only)', n; end if;

  select count(*) into n from public.traces where org_id = org_b;
  if n <> 0 then raise exception 'FAIL: CROSS-ORG READ — user A saw org B traces'; end if;
  raise notice 'PASS: user A sees only own org; cross-org read blocked';

  -- immutability: app user has neither UPDATE/DELETE grant NOR policy on traces
  -- (defense in depth). Either denial proves the ledger is not app-mutable.
  begin
    update public.traces set output = 'tampered' where id = trace_a;
    raise exception 'FAIL: trace was UPDATEable by app user';
  exception when insufficient_privilege then
    raise notice 'PASS: trace UPDATE denied to app user';
  end;
  begin
    delete from public.traces where id = trace_a;
    raise exception 'FAIL: trace was DELETEable by app user';
  exception when insufficient_privilege then
    raise notice 'PASS: trace DELETE denied to app user';
  end;

  -- correction: author forced to self -> inserting as self works
  insert into public.corrections (trace_id, org_id, corrected_output, rating, author)
  values (trace_a, org_a, 'better acme answer', 5, user_a);
  raise notice 'PASS: member correction with author=self accepted';

  -- correction with author != self must be rejected by WITH CHECK
  begin
    insert into public.corrections (trace_id, org_id, corrected_output, rating, author)
    values (trace_a, org_a, 'spoofed author', 3, user_b);
    raise exception 'FAIL: correction with spoofed author was accepted';
  exception when insufficient_privilege or check_violation then
    raise notice 'PASS: correction with author!=self rejected';
  end;

  -- user A cannot write a correction into org B (not a member)
  begin
    insert into public.corrections (trace_id, org_id, corrected_output, rating, author)
    values (trace_b, org_b, 'cross-org correction', 4, user_a);
    raise exception 'FAIL: user A wrote a correction into org B';
  exception when insufficient_privilege or check_violation then
    raise notice 'PASS: cross-org correction write blocked';
  end;

  -- === USER B ===
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  select count(*) into n from public.corrections;
  if n <> 0 then raise exception 'FAIL: user B saw % corrections from org A', n; end if;
  raise notice 'PASS: user B sees none of org A corrections';

  -- user B cannot edit user A's correction (author gate)
  update public.corrections set corrected_output = 'hijacked' where trace_id = trace_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user B edited user A correction (% rows)', n; end if;
  raise notice 'PASS: correction editable only by its author';

  -- create_org requires auth
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.create_org('Ghost Inc');
    raise exception 'FAIL: create_org succeeded without auth';
  exception when raise_exception then
    if sqlerrm like '%FAIL:%' then raise; end if;
    raise notice 'PASS: create_org rejects unauthenticated caller';
  end;

  raise notice '================ ALL RLS ASSERTIONS PASSED ================';
end $$;

rollback;
