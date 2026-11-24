-- Fixes from the 5-agent live run-through (4 customers + owner).
-- Each patch rewrites the LIVE function body by exact text replacement and fails loudly if the text is not found,
-- so nothing changes silently. Applied once, together with documents_screen.

create or replace function pg_temp.patch(p_sig text, p_old text, p_new text) returns void language plpgsql as $$
declare d text;
begin
  d := pg_get_functiondef(p_sig::regprocedure);
  if position(p_old in d) = 0 then raise exception 'patch %: text not found: %', p_sig, left(p_old, 80); end if;
  execute replace(d, p_old, p_new);
end $$;

-- US holidays: no kickoff / onboarding offers on these days
create or replace function public.us_holiday(d date) returns boolean language sql immutable as $$
  select (extract(month from d) = 1 and extract(day from d) = 1)
      or (extract(month from d) = 7 and extract(day from d) = 4)
      or (extract(month from d) = 12 and extract(day from d) in (24, 25, 31))
      -- Memorial Day: last Monday of May
      or (extract(month from d) = 5 and extract(isodow from d) = 1 and extract(month from d + 7) = 6)
      -- Labor Day: first Monday of September
      or (extract(month from d) = 9 and extract(isodow from d) = 1 and extract(day from d) <= 7)
      -- Thanksgiving (4th Thursday of November) and the Friday after
      or (extract(month from d) = 11 and extract(isodow from d) = 4 and extract(day from d) between 22 and 28)
      or (extract(month from d) = 11 and extract(isodow from d) = 5 and extract(day from d) between 23 and 29);
$$;

do $$ begin
  -- 1. no discovery-call reminders once the call is closed (won / lost)
  perform pg_temp.patch('public.queue_due_reminders()',
    $x$status not in ('cancelled','held','no_show')$x$, $x$status not in ('cancelled','held','no_show','won','lost')$x$);

  -- 2. the offer message: one time per line, and no holidays
  perform pg_temp.patch('public.offer_times(uuid,text)',
    $x$' ' order by o.n)$x$, $x$E'\n' order by o.n)$x$);
  perform pg_temp.patch('public.offer_times(uuid,text)',
    $x$else 'onboarding call' end || '? '$x$, $x$else 'onboarding call' end || E'?\n'$x$);
  perform pg_temp.patch('public.offer_times(uuid,text)',
    $x$|| v_lines || ' just reply '$x$, $x$|| v_lines || E'\n\njust reply '$x$);
  perform pg_temp.patch('public.offer_times(uuid,text)',
    $x$where a.starts_at >= now() + interval '2 days'$x$,
    $x$where a.starts_at >= now() + interval '2 days' and not public.us_holiday((a.starts_at at time zone v_zone)::date)$x$);
  perform pg_temp.patch('public.offer_times(uuid,text)',
    $x$where (fs.starts_at at time zone v_zone)::date < v_launch)$x$,
    $x$where (fs.starts_at at time zone v_zone)::date < v_launch and not public.us_holiday((fs.starts_at at time zone v_zone)::date))$x$);

  -- 3. the client's document link never carries the owner's setup notes
  perform pg_temp.patch('public.doc_get(text)',
    $x$v_terms := coalesce(ag.terms, '{}'::jsonb);$x$, $x$v_terms := coalesce(ag.terms, '{}'::jsonb) - 'placeholders';$x$);

  -- 4. no "[YOUR NAME]": until a signer is saved in Settings, the owner's own name signs
  perform pg_temp.patch('public.doc_get(text)',
    $x$coalesce(v_signer, '[YOUR NAME]')$x$,
    $x$coalesce(v_signer, (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()), '[YOUR NAME]')$x$);
  perform pg_temp.patch('public.agreement_terms(uuid)',
    $x$coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), '[YOUR NAME]')$x$,
    $x$coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()), '[YOUR NAME]')$x$);
  perform pg_temp.patch('public.mail_welcome(uuid,text,text,text,text)',
    $x$coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), '[YOUR NAME]')$x$,
    $x$coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()), '[YOUR NAME]')$x$);

  -- 5. welcome email: kickoff times come in the channel now (booking by chat)
  perform pg_temp.patch('public.mail_welcome(uuid,text,text,text,text)',
    $x$Pick a time on the first screen you see.</td>$x$, $x$We&rsquo;ll send you a few times in your channel. Just reply with the one that suits you.</td>$x$);
  perform pg_temp.patch('public.mail_welcome(uuid,text,text,text,text)',
    $x$Pick a time on the first screen you see.\n\n'$x$, $x$We''ll send you a few times in your channel. Just reply with the one that suits you.\n\n'$x$);

  -- 6. pack email on a 3-month term says so: "5 qualified calls a month, $1,200 a month for 3 months"
  perform pg_temp.patch('public.mail_pack(uuid,text,text)',
    $x$|| case when c.plan = 'pilot' then ' within 30 days of going live' else ' a month' end;$x$,
    $x$|| case when c.plan = 'pilot' then ' within 30 days of going live' else ' a month' end
             || case when c.term = '3month' and c.plan <> 'pilot'
                     then ', $' || to_char(c.monthly_fee, 'FM999,999,990') || ' a month for 3 months, paid up front' else '' end;$x$);
end $$;

-- 7. older agreement snapshots: their "[YOUR NAME]" also shows the owner's name until a signer is saved
do $$ declare d text; begin
  d := pg_get_functiondef('public.doc_get(text)'::regprocedure);
  if position($x$v_signer := nullif(btrim(coalesce(public.biz('signer_name'), '')), '');$x$ in d) = 0 then raise exception 'not found'; end if;
  execute replace(d, $x$v_signer := nullif(btrim(coalesce(public.biz('signer_name'), '')), '');$x$,
    $x$v_signer := coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()));$x$);
end $$;
