begin;
create table jam.spotify_connections (
 room_id uuid primary key references jam.rooms(id) on delete cascade,
 player_id uuid not null references jam.players(id) on delete cascade,
 account_id text unique not null, credentials text not null,
 lease uuid, lease_until timestamptz, checked_at timestamptz, retry_at timestamptz,
 snapshot jsonb not null default '{}', issue text
);
create table jam.spotify_oauth (
 state text primary key, room_id uuid not null references jam.rooms(id) on delete cascade,
 user_id uuid not null, player_id uuid not null references jam.players(id) on delete cascade,
 verifier text not null, expires_at timestamptz not null default now()+interval '10 minutes'
);
create table jam.spotify_tracks (id text primary key, data jsonb not null, fetched_at timestamptz not null default now());
alter table jam.requests add column spotify_track jsonb;
alter table jam.requests add column played_at timestamptz;
create table jam.spotify_jobs (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references jam.rooms(id) on delete cascade,
 request_id uuid unique references jam.requests(id) on delete cascade,
 kind text not null check(kind in ('song','skip')),
 target text not null, status text not null default 'waiting' check(status in ('waiting','sending','uncertain','done','failed')),
 created_at timestamptz not null default now(), issue text
);
alter table jam.spotify_connections enable row level security;
alter table jam.spotify_oauth enable row level security;
alter table jam.spotify_tracks enable row level security;
alter table jam.spotify_jobs enable row level security;
revoke all on jam.spotify_connections,jam.spotify_oauth,jam.spotify_tracks,jam.spotify_jobs from public,anon,authenticated;

-- A new musical host must explicitly connect their own account.
create function jam.spotify_role_change() returns trigger language plpgsql set search_path='' as $$
begin
 if new.music_id is distinct from old.music_id then
   if exists(select 1 from jam.spotify_jobs where room_id=new.id and status in ('waiting','sending','uncertain')) then
     raise exception 'Attendez la fin des envois Spotify ou réglez les demandes incertaines avant de changer de responsable.';
   end if;
   delete from jam.spotify_connections where room_id=new.id;
   delete from jam.spotify_oauth where room_id=new.id;
 end if;
 return new;
end $$;
create trigger spotify_role_change before update of music_id on jam.rooms for each row execute function jam.spotify_role_change();

-- Keep the proven game commands, while preventing manual processing of Spotify jobs.
alter function public.game_command(uuid,text,jsonb) set schema jam;
revoke all on function jam.game_command(uuid,text,jsonb) from public,anon,authenticated;
create function public.game_command(action_id uuid, kind text, payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jam.rooms; p jam.players; prior jam.receipts; result jsonb; track jsonb; rid uuid; conn jam.spotify_connections;
begin
 if auth.uid() is null then raise exception 'Veuillez vous reconnecter.'; end if;
 if action_id is null or payload is null or jsonb_typeof(payload)<>'object' then raise exception 'Action invalide.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 if kind in ('create','join','recover') then return jam.game_command(action_id,kind,payload); end if;
 select * into prior from jam.receipts x where x.user_id=auth.uid() and x.action_id=game_command.action_id;
 if found then
   if prior.kind<>game_command.kind or prior.payload<>game_command.payload then raise exception 'Identifiant déjà utilisé pour une autre action.'; end if;
   return prior.result;
 end if;
 select * into r from jam.rooms where id=(payload->>'roomId')::uuid for update;
 select * into p from jam.players where room_id=r.id and user_id=auth.uid();
 if p.id is null then raise exception 'Vous ne participez pas à cette soirée.'; end if;
 select * into conn from jam.spotify_connections where room_id=r.id;
 if kind='remove_player' and exists(select 1 from jam.spotify_jobs j join jam.requests q on q.id=j.request_id where j.room_id=r.id and q.player_id=(payload->>'playerId')::uuid and j.status in ('waiting','sending','uncertain')) then
   raise exception 'Terminez les envois Spotify de ce joueur avant de le supprimer.';
 end if;
 if kind in ('song','skip') and conn.room_id is not null then raise exception 'Utilisez la recherche et les commandes Spotify.'; end if;
 if kind in ('queue','reject','skip_done') and exists(select 1 from jam.spotify_jobs where request_id=(payload->>'requestId')::uuid) then
   raise exception 'Cette demande est traitée automatiquement par Spotify.';
 end if;
 if kind not in ('spotify_song','spotify_skip') then return jam.game_command(action_id,kind,payload); end if;
 if conn.room_id is null then raise exception 'Le responsable doit connecter Spotify.'; end if;
 if conn.issue is not null then raise exception 'Spotify est indisponible. Le responsable doit vérifier la connexion.'; end if;
 if not jam.throttle('user:'||auth.uid(),120,60) then raise exception 'Trop de demandes. Réessayez dans une minute.'; end if;
 if kind='spotify_song' then
   select data into track from jam.spotify_tracks where id=payload->>'trackId' and fetched_at>now()-interval '1 hour';
   if track is null then raise exception 'Recherchez à nouveau ce morceau avant de l’ajouter.'; end if;
   if p.adds<1 then raise exception 'Vous n’avez pas de jeton d’ajout.'; end if;
   if exists(select 1 from jam.requests pending_request where pending_request.player_id=p.id and pending_request.kind='song' and pending_request.status='pending') then raise exception 'Votre chanson précédente est encore en attente.'; end if;
   if exists(select 1 from jam.requests where room_id=r.id and spotify_track->>'id'=track->>'id' and status in ('pending','queued') and played_at is null) then raise exception 'Ce morceau est déjà demandé dans cette soirée.'; end if;
   insert into jam.requests(room_id,player_id,kind,text,spotify_track) values(r.id,p.id,'song',(track->>'name')||' — '||(track->>'artists'),track) returning id into rid;
   update jam.players set adds=adds-1 where id=p.id;
   insert into jam.ledger(player_id,source_id,operation,adds) values(p.id,rid,'spend',-1);
   insert into jam.spotify_jobs(room_id,request_id,kind,target) values(r.id,rid,'song',track->>'uri');
 else
   if not p.skip then raise exception 'Vous n’avez pas de jeton de skip.'; end if;
   if exists(select 1 from jam.requests pending_request where pending_request.room_id=r.id and pending_request.kind='skip' and pending_request.status='pending') then raise exception 'Un skip est déjà en attente. Votre jeton est conservé.'; end if;
   if conn.checked_at is null or conn.checked_at<now()-interval '30 seconds' or conn.snapshot->'current'->>'uri' is null then raise exception 'Actualisez Spotify pour connaître le morceau à passer.'; end if;
   insert into jam.requests(room_id,player_id,kind,text) values(r.id,p.id,'skip','Passer '||(conn.snapshot->'current'->>'name')) returning id into rid;
   insert into jam.ledger(player_id,source_id,operation) values(p.id,rid,'reserve');
   insert into jam.spotify_jobs(room_id,request_id,kind,target) values(r.id,rid,'skip',conn.snapshot->'current'->>'uri');
 end if;
 result:=jsonb_build_object('requestId',rid);
 insert into jam.receipts values(auth.uid(),action_id,kind,payload,result,now());
 update jam.rooms set last_activity_at=clock_timestamp() where id=r.id;
 return result;
end $$;
revoke all on function public.game_command(uuid,text,jsonb) from public,anon;
grant execute on function public.game_command(uuid,text,jsonb) to authenticated;

alter function public.game_state(uuid) set schema jam;
revoke all on function jam.game_state(uuid) from public,anon,authenticated;
create function public.game_state(room_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; spotify jsonb;
begin
 result:=jam.game_state(room_id);
 select jsonb_build_object('connected',true,'snapshot',c.snapshot,'checkedAt',c.checked_at,'issue',c.issue,
 'jobs',coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'requestId',j.request_id,'status',j.status,'issue',j.issue)) from jam.spotify_jobs j where j.room_id=c.room_id),'[]'))
 into spotify from jam.spotify_connections c where c.room_id=game_state.room_id;
 return result||jsonb_build_object('spotify',coalesce(spotify,'{"connected":false}'::jsonb));
end $$;
revoke all on function public.game_state(uuid) from public,anon;
grant execute on function public.game_state(uuid) to authenticated;

-- Only the authenticated Edge function may call this service boundary.
create function public.spotify_service(op text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jam.rooms; p jam.players; c jam.spotify_connections; j jam.spotify_jobs; q jam.requests;
 oauth jam.spotify_oauth; item jsonb; result jsonb; token uuid;
begin
 select * into r from jam.rooms where id=(args->>'roomId')::uuid for update;
 if r.id is null then raise exception 'Soirée introuvable.'; end if;
 if op not in ('finish','release','save_token','snapshot','claim','rooms') then
   select * into p from jam.players where room_id=r.id and user_id=(args->>'userId')::uuid;
   if p.id is null then raise exception 'Accès refusé.'; end if;
 end if;
 if op='access' then
   if not jam.throttle('spotify:'||p.id,50,60) then raise exception 'Trop de demandes Spotify. Patientez.'; end if;
   return jsonb_build_object('dj',p.id=r.music_id,'playerId',p.id);
 elsif op='oauth_start' then
   if p.id<>r.music_id then raise exception 'Seul le responsable musical peut connecter Spotify.'; end if;
   delete from jam.spotify_oauth where expires_at<now() or room_id=r.id;
   insert into jam.spotify_oauth(state,room_id,user_id,player_id,verifier) values(args->>'state',r.id,p.user_id,p.id,args->>'verifier');
 elsif op='oauth_take' then
   delete from jam.spotify_oauth where state=args->>'state' and room_id=r.id and user_id=p.user_id and player_id=r.music_id and expires_at>now() returning * into oauth;
   if oauth.state is null then raise exception 'Connexion expirée. Recommencez depuis la régie.'; end if;
   return jsonb_build_object('verifier',oauth.verifier);
 elsif op='connect' then
   if p.id<>r.music_id then raise exception 'Accès réservé au responsable musical.'; end if;
   if exists(select 1 from jam.requests manual_request where manual_request.room_id=r.id and manual_request.status='pending' and not exists(select 1 from jam.spotify_jobs pending_job where pending_job.request_id=manual_request.id)) then raise exception 'Terminez les demandes manuelles en attente avant de connecter Spotify.'; end if;
   if exists(select 1 from jam.spotify_connections where account_id=args->>'accountId' and room_id<>r.id) then raise exception 'Ce compte Spotify est déjà connecté à une autre soirée. Déconnectez-le de cette soirée avant de continuer.'; end if;
   if exists(select 1 from jam.spotify_connections where room_id=r.id and lease_until>now()) then raise exception 'Une opération Spotify est en cours. Réessayez dans quelques secondes.'; end if;
   if exists(select 1 from jam.spotify_jobs where room_id=r.id and status in ('sending','uncertain')) then raise exception 'Réglez les demandes incertaines avant de reconnecter Spotify.'; end if;
   insert into jam.spotify_connections(room_id,player_id,account_id,credentials) values(r.id,p.id,args->>'accountId',args->>'credentials')
   on conflict(room_id) do update set player_id=excluded.player_id,account_id=excluded.account_id,credentials=excluded.credentials,issue=null,snapshot='{}',checked_at=null,retry_at=null;
 elsif op='disconnect' then
   if p.id<>r.music_id then raise exception 'Accès réservé au responsable musical.'; end if;
   if exists(select 1 from jam.spotify_jobs where room_id=r.id and status in ('waiting','sending','uncertain')) then raise exception 'Réglez les demandes en cours avant de déconnecter Spotify.'; end if;
   delete from jam.spotify_connections where room_id=r.id;
   delete from jam.spotify_oauth where room_id=r.id;
 elsif op='cache' then
   for item in select value from jsonb_array_elements(args->'tracks') loop
     insert into jam.spotify_tracks(id,data) values(item->>'id',item) on conflict(id) do update set data=excluded.data,fetched_at=now();
   end loop;
   delete from jam.spotify_tracks where fetched_at<now()-interval '1 day';
 elsif op='resolve' then
   if p.id<>r.music_id then raise exception 'Accès réservé au responsable musical.'; end if;
   select * into c from jam.spotify_connections where room_id=r.id and lease=(args->>'lease')::uuid and lease_until>now();
   if c.room_id is null then raise exception 'Opération Spotify expirée.'; end if;
   select * into j from jam.spotify_jobs where id=(args->>'jobId')::uuid and room_id=r.id for update;
   if j.status is distinct from 'uncertain' then raise exception 'Cette demande n’est pas à vérifier.'; end if;
   if jsonb_typeof(args->'performed') is distinct from 'boolean' then raise exception 'Indiquez si Spotify a exécuté la commande.'; end if;
   update jam.spotify_jobs set status='sending' where id=j.id;
   return public.spotify_service('finish',args||jsonb_build_object('outcome',case when (args->>'performed')::boolean then 'ok' else 'failed' end,'issue','Commande non exécutée, jeton restitué.'));
 elsif op='lease' then
   select * into c from jam.spotify_connections where room_id=r.id;
   if c.room_id is null then raise exception 'Connectez Spotify depuis la régie.'; end if;
   if c.lease_until>now() then return jsonb_build_object('busy',true); end if;
   if c.retry_at>now() and args->>'purpose'<>'resolve' then return jsonb_build_object('busy',true); end if;
   if args->>'purpose'='sync' and c.checked_at>now()-interval '10 seconds' and not exists(select 1 from jam.spotify_jobs where room_id=r.id and status='waiting') then return jsonb_build_object('busy',true); end if;
   token:=gen_random_uuid();
   update jam.spotify_connections set lease=token,lease_until=now()+interval '90 seconds' where room_id=r.id;
   update jam.spotify_jobs set status='uncertain',issue='Réponse Spotify perdue. Vérifiez la file avant toute nouvelle tentative.' where room_id=r.id and status='sending';
   return jsonb_build_object('lease',token,'credentials',c.credentials,'snapshot',c.snapshot);
 else
   select * into c from jam.spotify_connections where room_id=r.id and lease=(args->>'lease')::uuid and lease_until>now();
   if c.room_id is null then raise exception 'Opération Spotify expirée.'; end if;
   if op='save_token' then
     update jam.spotify_connections set credentials=args->>'credentials' where room_id=r.id;
   elsif op='claim' then
     if exists(select 1 from jam.spotify_jobs where room_id=r.id and status in ('sending','uncertain')) then return null; end if;
     select * into j from jam.spotify_jobs where room_id=r.id and status='waiting' order by created_at,id limit 1 for update;
     if j.id is null then return null; end if;
     update jam.spotify_jobs set status='sending' where id=j.id;
     return to_jsonb(j);
   elsif op='finish' then
     select * into j from jam.spotify_jobs where id=(args->>'jobId')::uuid and room_id=r.id for update;
     if j.status is distinct from 'sending' then return '{}'; end if;
     select * into q from jam.requests where id=j.request_id;
     if args->>'outcome'='ok' then
       update jam.spotify_jobs set status='done',issue=null where id=j.id;
       update jam.requests set status=case when j.kind='song' then 'queued' else 'done' end,resolved_at=now() where id=q.id;
       if j.kind='skip' then
         update jam.players set skip=false where id=q.player_id;
         insert into jam.ledger(player_id,source_id,operation,skip) values(q.player_id,q.id,'spend',-1);
       elsif position('taylor swift' in lower(q.spotify_track->>'artists'))>0 then
         perform jam.emit(r.id,null,'taylor','Du Taylor Swift Arrive, bienvenue en enfer');
       end if;
     elsif args->>'outcome'='failed' then
       update jam.spotify_jobs set status='failed',issue=args->>'issue' where id=j.id;
       update jam.requests set status='rejected',reason=args->>'issue',resolved_at=now() where id=q.id;
       if j.kind='song' then update jam.players set adds=adds+1 where id=q.player_id; end if;
       insert into jam.ledger(player_id,source_id,operation,adds) values(q.player_id,q.id,'refund',case when j.kind='song' then 1 else 0 end);
     else
       update jam.spotify_jobs set status='uncertain',issue='Réponse perdue : le responsable doit vérifier ce qui a été exécuté.' where id=j.id;
     end if;
   elsif op='snapshot' then
     update jam.spotify_connections set snapshot=args->'snapshot',checked_at=now(),issue=null where room_id=r.id;
     -- A playback observation is evidence of starting, not proof of listening to the end.
     update jam.requests set played_at=now(),status='started' where room_id=r.id and status='queued' and played_at is null
       and spotify_track->>'uri'=args->'snapshot'->'current'->>'uri'
       and resolved_at < now()-make_interval(secs=>coalesce((args->'snapshot'->>'progressMs')::double precision,0)/1000.0)
       and coalesce((args->'snapshot'->>'playing')::boolean,false);
   elsif op='release' then
     update jam.spotify_connections set lease=null,lease_until=null,issue=args->>'issue',retry_at=case when args->>'retrySeconds' is not null then now()+make_interval(secs=>greatest(1,least(86400,(args->>'retrySeconds')::integer))) else null end where room_id=r.id;
   else raise exception 'Opération Spotify inconnue.';
   end if;
 end if;
 return '{}';
end $$;
revoke all on function public.spotify_service(text,jsonb) from public,anon,authenticated;
grant execute on function public.spotify_service(text,jsonb) to service_role;
revoke all on function jam.spotify_role_change() from public,anon,authenticated;

create function public.spotify_scheduler_context(room_key uuid) returns uuid
language sql security definer set search_path='' as $$
 select p.user_id from jam.rooms r join jam.players p on p.id=r.music_id join jam.spotify_connections c on c.room_id=r.id
 where r.id=room_key and (r.last_activity_at>now()-interval '6 hours' or exists(select 1 from jam.spotify_jobs j where j.room_id=r.id and j.status in ('waiting','sending')));
$$;
revoke all on function public.spotify_scheduler_context(uuid) from public,anon,authenticated;
grant execute on function public.spotify_scheduler_context(uuid) to service_role;
commit;


