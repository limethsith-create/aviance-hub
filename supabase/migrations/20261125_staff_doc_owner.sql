-- The welcome one-pager reads 'owner'; doc_get only returned 'owner_name', so the page fell back to a
-- hard-coded name. Return both, and prefer the signer name from Settings.
do $$ declare d text; begin
  d := pg_get_functiondef('public.doc_get(text)'::regprocedure);
  if position($x$'owner_name', (select nullif(btrim(o.name),'')$x$ in d) = 0 then raise exception 'doc_get: text not found'; end if;
  execute replace(d, $x$'owner_name', (select nullif(btrim(o.name),'')$x$,
                     $x$'owner', coalesce(nullif(btrim(public.biz('signer_name')), ''),
                                   (select nullif(btrim(o2.name),'') from public.profiles o2 where o2.id = public.aviance_owner())),
        'owner_name', (select nullif(btrim(o.name),'')$x$);
end $$;

-- GoTrue reads these columns as plain text, so a login row made by hand needs '' rather than null.
-- (The staff-code function uses the admin API, which fills them in; this is for any row made in SQL.)
update auth.users set confirmation_token = coalesce(confirmation_token,''),
                      recovery_token = coalesce(recovery_token,''),
                      email_change_token_new = coalesce(email_change_token_new,''),
                      email_change = coalesce(email_change,''),
                      email_change_token_current = coalesce(email_change_token_current,''),
                      phone_change = coalesce(phone_change,''),
                      phone_change_token = coalesce(phone_change_token,''),
                      reauthentication_token = coalesce(reauthentication_token,'')
 where confirmation_token is null or recovery_token is null or email_change_token_new is null
    or email_change is null or email_change_token_current is null or phone_change is null
    or phone_change_token is null or reauthentication_token is null;
