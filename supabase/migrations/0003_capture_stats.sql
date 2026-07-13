-- ============================================================================
-- HAYEK — 0003_capture_stats (Phase 1 follow-up)
-- The Edge proxy tees the stream and drains the capture branch in the
-- background (next/after). If a client disconnects mid-stream the drain can be
-- cut short and that trace is lost. Instead of hand-waving the rate, we count:
--   stream_started  incremented when a streaming tee is set up
--   stream_drained  incremented when the drain completes and the trace persists
-- The gap (started - drained) is the honest loss number. If it's 0.1%, ignore
-- it forever; if it's 8%, it's a bug hiding in a caveat.
-- ============================================================================

create table capture_stats (
  org_id         uuid primary key references orgs (id) on delete cascade,
  stream_started bigint not null default 0,
  stream_drained bigint not null default 0,
  updated_at     timestamptz not null default now()
);

alter table capture_stats enable row level security;
alter table capture_stats force row level security;

-- Members may read their org's numbers (a future dashboard tile). Only the
-- proxy (service role) writes, via the RPC below.
create policy "capture_stats: member read" on capture_stats for select using (is_org_member(org_id));

grant select on capture_stats to authenticated;
grant select, insert, update on capture_stats to service_role;

-- Atomic increment of one counter. SECURITY DEFINER + empty search_path; the
-- field name is validated (not interpolated) so there's no injection surface.
create or replace function bump_capture_stat(p_org uuid, p_field text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_field not in ('stream_started', 'stream_drained') then
    raise exception 'invalid capture stat field: %', p_field;
  end if;

  insert into public.capture_stats (org_id, stream_started, stream_drained)
  values (
    p_org,
    case when p_field = 'stream_started' then 1 else 0 end,
    case when p_field = 'stream_drained' then 1 else 0 end
  )
  on conflict (org_id) do update set
    stream_started = public.capture_stats.stream_started
      + case when p_field = 'stream_started' then 1 else 0 end,
    stream_drained = public.capture_stats.stream_drained
      + case when p_field = 'stream_drained' then 1 else 0 end,
    updated_at = now();
end;
$$;

grant execute on function bump_capture_stat(uuid, text) to service_role;
