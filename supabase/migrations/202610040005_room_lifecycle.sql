-- Room lifecycle: private helpers, administrator commands and six-month retention.
begin;
-- Start the retention clock now for existing rooms: historical activity was not tracked.
alter table jam.rooms add column last_activity_at timestamptz not null default now();
create index rooms_last_activity on jam.rooms(last_activity_at);
-- Preserve verdict history when its witness is removed.
alter table jam.attempts alter column witness_id drop not null;

create function jam.erase_room(room_key uuid) returns void
language plpgsql set search_path = '' as $$
declare joueurs uuid[];
begin
 perform 1 from jam.rooms where id=room_key for update;
 if not found then return; end if;
 select coalesce(array_agg(id),'{}'::uuid[]) into joueurs from jam.players where room_id=room_key;
  delete from jam.deliveries where event_id in (select id from jam.events where room_id = room_key)
    or subscription_id in (select id from jam.subscriptions where player_id = any(joueurs));
  delete from jam.subscriptions where player_id = any(joueurs);
  delete from jam.events where room_id = room_key;
  delete from jam.attempts where assignment_id in (select id from jam.assignments where room_id = room_key);
  delete from jam.assignments where room_id = room_key;
  delete from jam.requests where room_id = room_key;
  delete from jam.ledger where player_id = any(joueurs);
  delete from jam.challenges where room_id = room_key;
  -- Conserver uniquement un reçu neutralisé pour empêcher un ancien clic
  -- rejoué de recréer la soirée ; enlever ses données et codes de récupération.
  update jam.receipts set payload = '{}'::jsonb,
    result = '{"error":"Cette soirée a été supprimée."}'::jsonb
    where coalesce(result->>'roomId', payload->>'roomId') = room_key::text;
  delete from jam.limits where key = 'recover-room:' || room_key::text
    or key in (select 'push:' || unnest(joueurs)::text);
  update jam.rooms set admin_id = null, music_id = null where id = room_key;
  delete from jam.players where room_id = room_key;
  delete from jam.rooms where id = room_key;

end $$;

create function jam.remove_player(room_key uuid, player_key uuid) returns void
language plpgsql set search_path = '' as $$
declare target jam.players; r jam.rooms;
begin
 select * into r from jam.rooms where id=room_key for update;
 select * into target from jam.players where room_id=room_key and id=player_key;
 if not found then raise exception 'Joueur introuvable.'; end if;
 if target.id=r.admin_id then raise exception 'L’administrateur ne peut pas se supprimer. Vous pouvez supprimer la soirée entière.'; end if;
 if target.id=r.music_id then update jam.rooms set music_id=admin_id where id=room_key; end if;
 -- Other players keep the same challenge. Failed verdicts must remain failed.
 update jam.assignments set
   status=case when status in ('invited','running') then 'assigned' else status end,
   started_at=case when status in ('invited','running') then null else started_at end,
   witness_id=null, attempt_id=null
 where room_id=room_key and witness_id=player_key and player_id<>player_key;
 update jam.attempts set witness_id=null,
   resolved_at=case when status in ('invited','running') then now() else resolved_at end,
   status=case when status in ('invited','running') then 'invalidated' else status end
 where witness_id=player_key;
 delete from jam.attempts where assignment_id in (select id from jam.assignments where player_id=player_key);
 delete from jam.assignments where player_id=player_key;
 delete from jam.requests where player_id=player_key;
 delete from jam.ledger where player_id=player_key;
 delete from jam.deliveries where event_id in(select id from jam.events where recipient_id=player_key);
 delete from jam.events where recipient_id=player_key;
 delete from jam.subscriptions where player_id=player_key;
 update jam.receipts set payload='{}'::jsonb, result='{"error":"Ce profil a été supprimé."}'::jsonb
 where (user_id=target.user_id and coalesce(result->>'roomId',payload->>'roomId')=room_key::text)
    or result->>'playerId'=player_key::text;
 delete from jam.limits where key='push:'||player_key::text;
 delete from jam.players where id=player_key;
end $$;

-- Runs as the scheduler owner, never callable by a phone.
create function jam.purge_inactive_rooms() returns integer
language plpgsql set search_path = '' as $$
declare expired record; removed integer := 0;
begin
 for expired in select id from jam.rooms
   where last_activity_at < now()-interval '6 months'
   order by last_activity_at for update skip locked limit 100
 loop
   perform jam.erase_room(expired.id);
   removed := removed+1;
 end loop;
 return removed;
end $$;
revoke all on function jam.erase_room(uuid),jam.remove_player(uuid,uuid),jam.purge_inactive_rooms() from public,anon,authenticated,service_role;

create or replace function public.game_command(action_id uuid, kind text, payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 u uuid := auth.uid(); r jam.rooms; p jam.players; a jam.assignments; q jam.requests; c jam.challenges;
 prior jam.receipts; result jsonb := '{}'; rid uuid; pid uuid; wid uuid; aid uuid; reward boolean := false;
 n text; rh text; rate integer; roll double precision; seconds integer;
begin
 if u is null then raise exception 'Veuillez vous reconnecter.'; end if;
 if action_id is null or payload is null or jsonb_typeof(payload)<>'object' then raise exception 'Action invalide.'; end if;
 -- Serialize one identity, then one room. Every state-changing game operation uses this order.
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into prior from jam.receipts x where x.user_id=u and x.action_id=game_command.action_id;
 if found then
   if prior.kind<>game_command.kind or prior.payload<>game_command.payload then raise exception 'Identifiant déjà utilisé pour une autre action.'; end if;
   return prior.result;
 end if;
 if not jam.throttle('user:'||u,120,60) then return jsonb_build_object('error','Trop de demandes. Réessayez dans une minute.'); end if;

 if kind='create' then
   n:=btrim(payload->>'name'); rh:=payload->>'recoveryHash';
   if n is null or length(n) not between 1 and 30 then raise exception 'Choisissez un pseudo de 1 à 30 caractères.'; end if;
   if not jam.throttle('create:'||u,3,3600) then return jsonb_build_object('error','Limite de création atteinte. Réessayez plus tard.'); end if;
   rid:=gen_random_uuid();
   insert into jam.rooms(id,code,name) values(rid,upper(left(replace(rid::text,'-',''),12)),coalesce(nullif(btrim(payload->>'roomName'),''),'La soirée')) returning * into r;
   insert into jam.players(room_id,user_id,name,recovery_hash) values(r.id,u,n,rh) returning * into p;
   update jam.rooms set admin_id=p.id,music_id=p.id where id=r.id;
   insert into jam.challenges(room_id,text,duration) values
    (r.id,'Fais dire « parthénogenèse » à un autre participant.',120),
    (r.id,'Fais deviner un film à un participant en le mimant, sans parler.',120),
    (r.id,'Fais deviner une chanson à un participant en la fredonnant sans paroles.',90),
    (r.id,'Récite les mois de l’année à l’envers, sans erreur.',60);
   result:=jsonb_build_object('roomId',r.id,'playerId',p.id,'code',r.code);
 elsif kind in ('join','recover') then
   select * into r from jam.rooms where code=upper(regexp_replace(payload->>'code','[\s-]','','g')) for update;
   if not found then return jsonb_build_object('error','Code de soirée introuvable.'); end if;
   if kind='join' then
     select * into p from jam.players where room_id=r.id and user_id=u;
     if not found then
       n:=btrim(payload->>'name');
       if n is null or length(n) not between 1 and 30 then raise exception 'Choisissez un pseudo de 1 à 30 caractères.'; end if;
       if (select count(*) from jam.players where room_id=r.id)>=50 then raise exception 'Cette soirée a atteint 50 participants.'; end if;
       insert into jam.players(room_id,user_id,name,recovery_hash) values(r.id,u,n,payload->>'recoveryHash') returning * into p;
     else
       update jam.players set recovery_hash=payload->>'recoveryHash' where id=p.id;
     end if;
   else
     -- Failed recovery attempts return normally so the throttle is committed.
     if not jam.throttle('recover-user:'||u,5,900) or not jam.throttle('recover-room:'||r.id,100,900) then
       return jsonb_build_object('error','Trop de tentatives. Attendez 15 minutes.');
     end if;
     select * into p from jam.players where room_id=r.id and recovery_hash=payload->>'recoveryHash';
     if not found then return jsonb_build_object('error','Code personnel incorrect.'); end if;
     if exists(select 1 from jam.players where room_id=r.id and user_id=u and id<>p.id) then raise exception 'Déconnectez votre profil actuel avant de récupérer un autre profil.'; end if;
     update jam.players set user_id=u,recovery_hash=payload->>'newRecoveryHash' where id=p.id;
     -- Old devices lose both game access and notification access.
     delete from jam.subscriptions where player_id=p.id;
   end if;
   result:=jsonb_build_object('roomId',r.id,'playerId',p.id,'code',r.code);
 else
   select * into r from jam.rooms where id=(payload->>'roomId')::uuid for update;
   if not found then raise exception 'Soirée introuvable.'; end if;
   select * into p from jam.players where room_id=r.id and user_id=u;
   if not found then raise exception 'Vous ne participez pas à cette soirée.'; end if;

   if kind='draw' then
     if p.cooldown_until>clock_timestamp() then raise exception 'Attendez la fin des deux minutes.'; end if;
     if exists(select 1 from jam.assignments where player_id=p.id and status not in ('won','abandoned')) then raise exception 'Vous avez déjà une épreuve.'; end if;
     select * into c from jam.challenges where room_id=r.id and active order by random() limit 1;
     if not found then raise exception 'Aucun défi actif. Contactez l’administrateur.'; end if;
     insert into jam.assignments(room_id,player_id,kind,text,duration) values(r.id,p.id,'challenge',c.text,c.duration) returning id into aid;
     result:=jsonb_build_object('assignmentId',aid);

   elsif kind in ('sacrifice','invite','accept','decline','verdict','abandon') then
     select * into a from jam.assignments where id=(payload->>'assignmentId')::uuid and room_id=r.id;
     if not found or a.status in ('won','abandoned') then raise exception 'Cette épreuve n’est plus disponible.'; end if;
     if kind in ('sacrifice','invite','abandon') then
       if a.player_id<>p.id then raise exception 'Cette épreuve ne vous appartient pas.'; end if;
     else
       if a.witness_id is distinct from p.id or a.attempt_id is distinct from (payload->>'attemptId')::uuid then raise exception 'Vous n’êtes pas le témoin autorisé de cette tentative.'; end if;
     end if;
     if kind='abandon' then
       update jam.attempts set status='invalidated',resolved_at=now() where id=a.attempt_id and status in ('invited','running');
       update jam.assignments set status='abandoned' where id=a.id;
       update jam.players set cooldown_until=clock_timestamp()+interval '2 minutes' where id=p.id;
     elsif kind='sacrifice' then
       if a.kind='sacrifice' then raise exception 'Le sacrifice est déjà choisi.'; end if;
       if btrim(r.sacrifice)='' then raise exception 'Le sacrifice liquide doit être configuré par l’administrateur.'; end if;
       update jam.attempts set status='invalidated',resolved_at=now() where id=a.attempt_id and status in ('invited','running');
       update jam.assignments set kind='sacrifice',text=r.sacrifice,duration=null,status='assigned',attempt_id=null,witness_id=null,started_at=null where id=a.id;
     elsif kind='invite' then
       if a.status='failed' then raise exception 'Après échec, choisissez le sacrifice ou abandonnez.'; end if;
       wid:=(payload->>'witnessId')::uuid;
       if wid=p.id or not exists(select 1 from jam.players where id=wid and room_id=r.id) then raise exception 'Choisissez un autre participant de cette soirée.'; end if;
       if a.status='running' and not coalesce((payload->>'unavailable')::boolean,false) then raise exception 'Confirmez l’indisponibilité du témoin.'; end if;
       update jam.attempts set status='invalidated',resolved_at=now() where id=a.attempt_id and status in ('invited','running');
       aid:=gen_random_uuid();
       insert into jam.attempts(id,assignment_id,witness_id,status) values(aid,a.id,wid,'invited');
       update jam.assignments set status='invited',attempt_id=aid,witness_id=wid,started_at=null where id=a.id;
       perform jam.emit(r.id,wid,'invitation',p.name||' vous demande d’être témoin.');
     elsif kind='accept' then
       if a.status<>'invited' then raise exception 'Cette invitation n’est plus disponible.'; end if;
       update jam.attempts set status='running',started_at=clock_timestamp() where id=a.attempt_id;
       update jam.assignments set status='running',started_at=(select started_at from jam.attempts where id=a.attempt_id) where id=a.id;
     elsif kind='decline' then
       if a.status<>'invited' then raise exception 'Cette invitation n’est plus disponible.'; end if;
       update jam.attempts set status='declined',resolved_at=now() where id=a.attempt_id;
       update jam.assignments set status='assigned',witness_id=null,attempt_id=null where id=a.id;
     elsif kind='verdict' then
       if a.status<>'running' then raise exception 'Le témoin doit accepter avant de rendre son verdict.'; end if;
       if coalesce((payload->>'success')::boolean,false) then
         if a.duration is not null and not coalesce((payload->>'inTime')::boolean,false) then raise exception 'Attestez la réussite dans le temps imparti.'; end if;
         select * into p from jam.players where id=a.player_id;
         rate:=null; roll:=null;
         if a.kind='challenge' and not p.skip then rate:=r.bonus; roll:=random(); reward:=roll<rate/100.0; end if;
         update jam.assignments set status='won',bonus_rate=rate,bonus_roll=roll,bonus_won=reward where id=a.id;
         update jam.attempts set status='won',resolved_at=now(),in_time=coalesce((payload->>'inTime')::boolean,false) where id=a.attempt_id;
         update jam.players set adds=adds+1,skip=skip or reward where id=p.id;
         insert into jam.ledger(player_id,source_id,operation,adds,skip) values(p.id,a.id,'reward',1,case when reward then 1 else 0 end);
         perform jam.emit(r.id,r.music_id,'success',p.name||' a réussi une épreuve : +1 jeton d’ajout'||case when reward then ' et +1 skip.' else '.' end);
         perform jam.emit(r.id,p.id,'reward','Réussite validée ! +1 jeton d’ajout'||case when reward then ' et +1 skip.' else '.' end);
       else
         update jam.assignments set status='failed' where id=a.id;
         update jam.attempts set status='failed',resolved_at=now() where id=a.attempt_id;
       end if;
     end if;

   elsif kind='song' then
     n:=payload->>'text';
     if n is null or length(btrim(n))=0 or length(n)>500 then raise exception 'Saisissez une demande de 1 à 500 caractères.'; end if;
     if p.adds<1 then raise exception 'Vous n’avez pas de jeton d’ajout.'; end if;
     if exists(select 1 from jam.requests req where req.player_id=p.id and req.kind='song' and req.status='pending') then raise exception 'Votre chanson précédente est encore en attente.'; end if;
     insert into jam.requests(room_id,player_id,kind,text) values(r.id,p.id,'song',n) returning id into aid;
     update jam.players set adds=adds-1 where id=p.id;
     insert into jam.ledger(player_id,source_id,operation,adds) values(p.id,aid,'spend',-1);
     perform jam.emit(r.id,r.music_id,'song',p.name||' propose : '||n);
   elsif kind='skip' then
     if not p.skip then raise exception 'Vous n’avez pas de jeton de skip.'; end if;
     if exists(select 1 from jam.requests req where req.room_id=r.id and req.kind='skip' and req.status='pending') then raise exception 'Un skip est déjà en attente. Votre jeton est conservé.'; end if;
     insert into jam.requests(room_id,player_id,kind,text) values(r.id,p.id,'skip','Passer le morceau en cours') returning id into aid;
     -- p.skip remains true while reserved; it cannot receive another bonus.
     insert into jam.ledger(player_id,source_id,operation) values(p.id,aid,'reserve');
     perform jam.emit(r.id,r.music_id,'skip',p.name||' demande de passer le morceau en cours.');
   elsif kind in ('queue','reject','skip_done') then
     if r.music_id<>p.id then raise exception 'Seul le responsable musical peut traiter cette demande.'; end if;
     select * into q from jam.requests where id=(payload->>'requestId')::uuid and room_id=r.id;
     if not found or q.status<>'pending' then raise exception 'Cette demande est déjà traitée ou introuvable.'; end if;
     if kind='queue' then
       if q.kind<>'song' or q.status<>'pending' then raise exception 'Cette chanson est déjà ajoutée ou indisponible.'; end if;
       update jam.requests set status='queued',resolved_at=clock_timestamp() where id=q.id;
       if position('taylor swift' in lower(q.text))>0 then perform jam.emit(r.id,null,'taylor','Du Taylor Swift Arrive, bienvenue en enfer'); end if;
     elsif kind='skip_done' then
       if q.kind<>'skip' or not coalesce((payload->>'performed')::boolean,false) then raise exception 'Confirmez que vous avez réellement passé le morceau.'; end if;
       update jam.requests set status='done',resolved_at=now() where id=q.id;
       update jam.players set skip=false where id=q.player_id;
       insert into jam.ledger(player_id,source_id,operation,skip) values(q.player_id,q.id,'spend',-1);
     else
       n:=btrim(payload->>'reason');
       if n is null or length(n) not between 1 and 300 then raise exception 'Indiquez un motif de refus (1 à 300 caractères).'; end if;
       update jam.requests set status='rejected',reason=n,resolved_at=now() where id=q.id;
       if q.kind='song' then update jam.players set adds=adds+1 where id=q.player_id; end if;
       insert into jam.ledger(player_id,source_id,operation,adds) values(q.player_id,q.id,'refund',case when q.kind='song' then 1 else 0 end);
       perform jam.emit(r.id,q.player_id,'refund','Demande annulée, jeton restitué : '||n);
     end if;
   elsif kind in ('remove_player','delete_room') then
     if r.admin_id is distinct from p.id then raise exception 'Accès réservé à l’administrateur.'; end if;
     if (payload->>'confirmed')::boolean is distinct from true then raise exception 'Confirmez la suppression définitive.'; end if;
     if kind='remove_player' then
       perform jam.remove_player(r.id,(payload->>'playerId')::uuid);
     else
       if payload->>'roomCode' is distinct from r.code then raise exception 'Recopiez le code de la soirée pour confirmer.'; end if;
       perform jam.erase_room(r.id);
       result:=jsonb_build_object('deleted',true);
     end if;
   elsif kind='settings' then
     if r.admin_id<>p.id then raise exception 'Accès réservé à l’administrateur.'; end if;
     wid:=(payload->>'musicId')::uuid;
     if not exists(select 1 from jam.players where id=wid and room_id=r.id) then raise exception 'Responsable musical invalide.'; end if;
     if length(coalesce(payload->>'sacrifice',''))>1000 then raise exception 'Le sacrifice est limité à 1 000 caractères.'; end if;
     rate:=(payload->>'bonus')::integer;
     if rate is null or rate not between 0 and 100 then raise exception 'La probabilité doit être comprise entre 0 et 100.'; end if;
     update jam.rooms set bonus=rate,sacrifice=coalesce(payload->>'sacrifice',''),music_id=wid where id=r.id;
   elsif kind='challenge' then
     if r.admin_id<>p.id then raise exception 'Accès réservé à l’administrateur.'; end if;
     n:=btrim(payload->>'text'); seconds:=nullif(payload->>'duration','')::integer;
     if n is null or length(n) not between 1 and 1000 then raise exception 'Le défi doit contenir de 1 à 1 000 caractères.'; end if;
     if nullif(payload->>'challengeId','') is null then
       insert into jam.challenges(room_id,text,duration,active) values(r.id,n,seconds,coalesce((payload->>'active')::boolean,true));
     else
       update jam.challenges set text=n,duration=seconds,active=coalesce((payload->>'active')::boolean,true) where id=(payload->>'challengeId')::uuid and room_id=r.id;
       if not found then raise exception 'Défi introuvable.'; end if;
     end if;
   elsif kind='subscribe' then
     n:=payload->>'endpoint';
     if length(n)>2048 or n !~ '^https://([a-zA-Z0-9-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)/' then raise exception 'Service de notification non reconnu.'; end if;
     if coalesce(payload->>'p256dh','') !~ '^[A-Za-z0-9_-]{80,150}$' or coalesce(payload->>'auth','') !~ '^[A-Za-z0-9_-]{20,50}$' then raise exception 'Clés de notification invalides.'; end if;
     insert into jam.subscriptions(player_id,endpoint,p256dh,auth) values(p.id,n,payload->>'p256dh',payload->>'auth')
       on conflict(endpoint) do update set player_id=excluded.player_id,p256dh=excluded.p256dh,auth=excluded.auth;
   elsif kind='unsubscribe' then
     delete from jam.subscriptions where player_id=p.id and endpoint=payload->>'endpoint';
   elsif kind='test_push' then
     if not exists(select 1 from jam.subscriptions where player_id=p.id) then raise exception 'Activez les notifications sur ce téléphone avant de les tester.'; end if;
     if not jam.throttle('push:'||p.id,3,60) then return jsonb_build_object('error','Attendez une minute avant un nouveau test.'); end if;
     perform jam.emit(r.id,p.id,'test','Test Jam : les notifications sont prêtes pour la soirée.');
   else raise exception 'Action inconnue.';
   end if;
 end if;
 update jam.rooms set last_activity_at=clock_timestamp() where id=r.id;
 insert into jam.receipts(user_id,action_id,kind,payload,result) values(u,action_id,kind,payload,result);
 return result;
end $$;

create or replace function public.game_state(room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jam.rooms; p jam.players;
begin
 select * into r from jam.rooms where id=room_id for update;
 select * into p from jam.players x where x.room_id=game_state.room_id and x.user_id=auth.uid();
 if r.id is null then raise exception using errcode='JAM01', message='Cette soirée a été supprimée.'; end if;
 if p.id is null then raise exception using errcode='JAM01', message='Ce profil n’a plus accès à la soirée. Il a été supprimé ou récupéré sur un autre appareil.'; end if;
 -- Successful reads count as activity, including an already-open foreground app.
 update jam.rooms set last_activity_at=clock_timestamp() where id=r.id returning * into r;
 return jsonb_build_object(
 'serverTime',clock_timestamp(), 'room',to_jsonb(r),
 'me',to_jsonb(p)-'user_id'-'recovery_hash',
 'players',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'name',x.name)) from jam.players x where x.room_id=r.id),'[]'),
 'challenges',coalesce((select jsonb_agg(to_jsonb(x) order by x.text) from jam.challenges x where x.room_id=r.id),'[]'),
 'assignments',coalesce((select jsonb_agg(to_jsonb(x)-'bonus_roll' order by x.created_at desc) from jam.assignments x where x.room_id=r.id and (x.player_id=p.id or x.witness_id=p.id) and x.status not in ('won','abandoned')),'[]'),
 'requests',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from jam.requests x where x.room_id=r.id and (x.status='pending' or x.player_id=p.id or p.id=r.music_id)),'[]'),
 'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (select x.* from jam.events x where x.room_id=r.id and (x.recipient_id is null or x.recipient_id=p.id or (p.id=r.music_id and x.kind in ('success','song','skip'))) order by x.created_at desc limit 60) e),'[]'),
 'ledger',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (select x.* from jam.ledger x where x.player_id=p.id order by x.created_at desc limit 50) e),'[]')
 );
end $$;


commit;
