begin;
create function public.owner_players(room_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from jam.site_owner where user_id=auth.uid()) then raise exception 'Accès réservé au propriétaire.' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'adds',p.adds,'skip',p.skip,'admin',p.id=r.admin_id,'music',p.id=r.music_id) order by p.created_at,p.id) from jam.players p join jam.rooms r on r.id=p.room_id where r.id=room_key),'[]');
end $$;
create function public.owner_player_action(action_id uuid, room_key uuid, player_key uuid, operation text, options jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jam.rooms; p jam.players; prior jam.receipts; data jsonb; result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from jam.site_owner where user_id=auth.uid()) then raise exception 'Accès réservé au propriétaire.' using errcode='42501'; end if;
 if action_id is null or options is null or jsonb_typeof(options)<>'object' then raise exception 'Action invalide.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 data:=jsonb_build_object('roomId',room_key,'playerId',player_key,'operation',operation,'options',options);
 select * into prior from jam.receipts x where x.user_id=auth.uid() and x.action_id=owner_player_action.action_id;
 if found then
   if prior.kind<>'owner_player' or prior.payload<>data then raise exception 'Cette action a déjà été utilisée.'; end if;
   return prior.result;
 end if;
 select * into r from jam.rooms where id=room_key for update;
 select * into p from jam.players where id=player_key and room_id=room_key;
 if r.id is null or p.id is null then raise exception 'Joueur ou soirée introuvable.'; end if;
 if operation='recovery' then
   if coalesce(options->>'hash','') !~ '^[a-f0-9]{64}$' then raise exception 'Code invalide.'; end if;
   update jam.players set recovery_hash=options->>'hash' where id=p.id;
 elsif operation='delete' then
   if options->>'name' is distinct from p.name then raise exception 'Recopiez le pseudo exact pour confirmer.'; end if;
   if exists(select 1 from jam.spotify_jobs j join jam.requests q on q.id=j.request_id where q.player_id=p.id and j.status in ('waiting','sending','uncertain')) then raise exception 'Terminez les envois Spotify de ce joueur avant de le supprimer.'; end if;
   if p.id=r.admin_id then
     if not exists(select 1 from jam.players where room_id=r.id and id=(options->>'successor')::uuid and id<>p.id) then raise exception 'Choisissez un autre administrateur, ou supprimez la soirée entière.'; end if;
     update jam.rooms set admin_id=(options->>'successor')::uuid where id=r.id;
   end if;
   perform jam.remove_player(r.id,p.id);
 else raise exception 'Action inconnue.';
 end if;
 result:=jsonb_build_object('ok',true);
 insert into jam.receipts values(auth.uid(),action_id,'owner_player',data,result,now());
 return result;
end $$;
revoke all on function public.owner_players(uuid),public.owner_player_action(uuid,uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.owner_players(uuid),public.owner_player_action(uuid,uuid,uuid,text,jsonb) to authenticated;
commit;
