-- Run once in Supabase SQL Editor, after the owner has created and confirmed
-- their email account. Never grant ownership to a guest/anonymous identity.
-- Replace only the email below. This refuses an unconfirmed or ambiguous user.
do $$
declare owner_id uuid;
begin
 select id into strict owner_id from auth.users
 where lower(email)=lower('REMPLACER_PAR_VOTRE_EMAIL')
   and email_confirmed_at is not null and coalesce(is_anonymous,false)=false;
 insert into jam.site_owner(singleton,user_id) values(true,owner_id)
 on conflict(singleton) do update set user_id=excluded.user_id;
end $$;
