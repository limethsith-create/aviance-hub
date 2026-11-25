-- A single caller must never sit idle in front of leads nobody owns.
--
-- leads_import assigns each row round-robin to the callers whose status is
-- 'new', 'invited' or 'active'. If a CSV is imported before any caller exists,
-- every row lands with assigned_to null, and before this change those rows were
-- invisible to every caller for ever: caller_next_id only ever looked at leads
-- already assigned to her.
--
-- Now, when a caller has nothing of her own waiting, she claims the oldest
-- unowned lead. 'for update skip locked' keeps that safe with several callers
-- dialling at once: two of them can never claim the same row.
create or replace function public.caller_next_id(p_caller uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  select l.id into v_id
    from public.leads l
   where l.assigned_to = p_caller
     and l.status <> 'done'
     and (l.callback_at is null or l.callback_at <= now())
   order by case when l.callback_at is not null then 0
                 when l.status = 'new' then 1
                 else 2 end,
            coalesce(l.callback_at, l.created_at), l.created_at
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  update public.leads l
     set assigned_to = p_caller
   where l.id = (select l2.id
                   from public.leads l2
                  where l2.assigned_to is null
                    and l2.status <> 'done'
                    and (l2.callback_at is null or l2.callback_at <= now())
                  order by l2.created_at
                  limit 1
                  for update skip locked)
  returning l.id into v_id;

  return v_id;
end
$$;

revoke all on function public.caller_next_id(uuid) from public;
grant execute on function public.caller_next_id(uuid) to authenticated;
