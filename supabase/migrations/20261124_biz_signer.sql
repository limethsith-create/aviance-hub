-- Settings: two more business details the documents use — who signs for Aviance, and a phone.
create or replace function public.biz(p_key text) returns text
language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    nullif(btrim((select w.data->'business'->>p_key from public.workspace_admin w where w.id = 1)), ''),
    case p_key
      when 'legal_name'    then '[YOUR COMPANY LEGAL NAME]'
      when 'address'       then '[YOUR COMPANY ADDRESS]'
      when 'email'         then 'aviancelk@gmail.com'
      when 'wise_details'  then '[WISE BANK DETAILS — add in Settings]'
      when 'payoneer_link' then ''
      when 'kickoff_link'  then 'https://www.aviance.online/book'
      when 'site'          then 'https://aviance.store'
      when 'signer_name'   then ''
      when 'phone'         then ''
      else '' end);
$$;
revoke execute on function public.biz(text) from public, anon, authenticated;

create or replace function public.biz_get() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'Only the owner can see these settings.'; end if;
  return jsonb_build_object(
    'legal_name', public.biz('legal_name'), 'address', public.biz('address'), 'email', public.biz('email'),
    'wise_details', public.biz('wise_details'), 'payoneer_link', public.biz('payoneer_link'),
    'kickoff_link', public.biz('kickoff_link'), 'site', public.biz('site'),
    'signer_name', public.biz('signer_name'), 'phone', public.biz('phone'));
end $$;

create or replace function public.biz_set(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare k text; clean jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then raise exception 'Only the owner can change these settings.'; end if;
  for k in select jsonb_object_keys(coalesce(p,'{}'::jsonb)) loop
    if k = any (array['legal_name','address','email','wise_details','payoneer_link','kickoff_link','site','signer_name','phone']) then
      if k in ('payoneer_link','kickoff_link','site') and btrim(coalesce(p->>k,'')) <> '' and (p->>k) !~* '^https://\S+$' then
        raise exception 'Links have to start with https://';
      end if;
      clean := clean || jsonb_build_object(k, left(btrim(coalesce(p->>k,'')), 2000));
    end if;
  end loop;
  insert into public.workspace_admin(id, data) values (1, jsonb_build_object('business', clean))
  on conflict (id) do update
    set data = public.workspace_admin.data || jsonb_build_object('business', coalesce(public.workspace_admin.data->'business','{}'::jsonb) || clean),
        updated_at = now();
  return public.biz_get();
end $$;
revoke execute on function public.biz_get(), public.biz_set(jsonb) from public, anon;
grant  execute on function public.biz_get(), public.biz_set(jsonb) to authenticated;
