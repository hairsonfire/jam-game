begin;
-- Only a database operator can grant this role. Room admins are not site owners.
create table jam.site_owner (
 singleton boolean primary key default true check(singleton),
 user_id uuid unique not null
);
alter table jam.site_owner enable row level security;
revoke all on jam.site_owner from public,anon,authenticated,service_role;

create function public.owner_rooms() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from jam.site_owner where user_id=auth.uid()) then
   raise exception 'Accès réservé au propriétaire.' using errcode='42501';
 end if;
 return coalesce((select jsonb_agg(to_jsonb(summary) order by summary.last_activity_at desc,summary.id) from (
   select r.id,r.name,r.code,r.created_at,r.last_activity_at,
     (select count(*) from jam.players p where p.room_id=r.id) as players,
     exists(select 1 from jam.spotify_connections c where c.room_id=r.id) as spotify
   from jam.rooms r
 ) summary),'[]'::jsonb);
end $$;
create function public.owner_delete_room(room_key uuid, confirmation_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target jam.rooms;
begin
 if auth.uid() is null or not exists(select 1 from jam.site_owner where user_id=auth.uid()) then
   raise exception 'Accès réservé au propriétaire.' using errcode='42501';
 end if;
 select * into target from jam.rooms where id=room_key for update;
 -- A retried deletion after a lost response is harmless.
 if not found then return jsonb_build_object('deleted',true); end if;
 if confirmation_code is distinct from target.code then
   raise exception 'Recopiez le code exact de la soirée pour confirmer.';
 end if;
 perform jam.erase_room(room_key);
 return jsonb_build_object('deleted',true);
end $$;
revoke all on function public.owner_rooms(),public.owner_delete_room(uuid,text) from public,anon;
grant execute on function public.owner_rooms(),public.owner_delete_room(uuid,text) to authenticated;
commit;
