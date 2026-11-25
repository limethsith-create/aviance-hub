-- One-click invite links for callers and employees.
--
-- The owner sends one link. She clicks it and lands on her page already signed
-- in: no Gmail to type, no access code to copy. The link carries a random
-- 32-character token; only its sha256 hash is ever stored, the same way the
-- access code is handled.
--
-- Trade-off, deliberate and documented: the link works more than once until it
-- expires, because a link that dies on the first click breaks the moment she
-- reopens the email or taps it twice. That makes it a bearer credential sitting
-- in an inbox, exactly like the access code we already mail her. It expires on
-- its own, the owner can revoke it at any time, and every use is counted so an
-- unexpected number is visible.
--
-- pgcrypto lives in the extensions schema and these functions pin search_path
-- to public, so digest() and gen_random_bytes() are named in full.
alter table public.staff
  add column if not exists link_hash       text,
  add column if not exists link_expires_at timestamptz,
  add column if not exists link_made_at    timestamptz,
  add column if not exists link_last_used  timestamptz,
  add column if not exists link_uses       int not null default 0;

comment on column public.staff.link_hash is
  'sha256 of the one-click invite token. The token itself is shown to the owner once and never stored.';

create or replace function public.staff_link_new(p_staff uuid, p_days int default 14)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  v_days  int := greatest(1, least(coalesce(p_days, 14), 60));
  v_row   public.staff;
begin
  if not public.is_admin() then
    raise exception 'Only the owner can make an invite link.';
  end if;
  select * into v_row from public.staff where id = p_staff;
  if v_row.id is null then
    raise exception 'That person is not on the staff list.';
  end if;
  if v_row.status = 'revoked' then
    raise exception 'That person is revoked. Restore them first.';
  end if;

  -- url-safe, no padding, nothing that breaks when pasted into a mail client
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', 'xyz');

  update public.staff
     set link_hash       = encode(extensions.digest(v_token, 'sha256'), 'hex'),
         link_expires_at = now() + make_interval(days => v_days),
         link_made_at    = now(),
         link_last_used  = null,
         link_uses       = 0
   where id = p_staff;

  return jsonb_build_object(
    'ok', true, 'token', v_token, 'kind', v_row.kind, 'name', v_row.name,
    'expires_at', (now() + make_interval(days => v_days)));
end
$$;

-- Consume a link. Called by the caller-link edge function with the service
-- role: it hands back the email so the function can mint a one-time sign-in.
create or replace function public.staff_link_claim(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.staff;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' and not public.is_admin() then
    raise exception 'Not allowed.';
  end if;
  if coalesce(btrim(p_token), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'no token');
  end if;

  select * into v_row
    from public.staff
   where link_hash = encode(extensions.digest(btrim(p_token), 'sha256'), 'hex')
   limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'unknown');
  end if;
  if v_row.status = 'revoked' then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;
  if v_row.link_expires_at is null or v_row.link_expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  update public.staff
     set link_last_used = now(),
         link_uses      = link_uses + 1,
         status         = case when status = 'invited' then 'active' else status end
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'email', v_row.email,
                            'kind', v_row.kind, 'name', v_row.name);
end
$$;

create or replace function public.staff_link_clear(p_staff uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() and coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'Not allowed.';
  end if;
  update public.staff
     set link_hash = null, link_expires_at = null, link_made_at = null
   where id = p_staff;
end
$$;

revoke all on function public.staff_link_new(uuid, int)  from public;
revoke all on function public.staff_link_claim(text)     from public;
revoke all on function public.staff_link_clear(uuid)     from public;
grant execute on function public.staff_link_new(uuid, int) to authenticated;
grant execute on function public.staff_link_claim(text)    to service_role;
grant execute on function public.staff_link_clear(uuid)    to authenticated, service_role;
