-- All game tables are private. Clients only access the checked RPC commands.
create schema if not exists jam;
revoke all on schema jam from public;

create table jam.rooms (
 id uuid primary key, code text unique not null, name text not null check(length(name) between 1 and 60),
 admin_id uuid, music_id uuid, bonus integer not null default 0 check(bonus between 0 and 100),
 sacrifice text not null default '', created_at timestamptz not null default now()
);
create table jam.players (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references jam.rooms(id), user_id uuid not null,
 name text not null check(length(name) between 1 and 30), recovery_hash text not null unique check(recovery_hash ~ '^[a-f0-9]{64}$'),
 adds integer not null default 0 check(adds >= 0), skip boolean not null default false,
 cooldown_until timestamptz, created_at timestamptz not null default now(), unique(room_id,user_id)
);
alter table jam.rooms add foreign key (admin_id) references jam.players(id);
alter table jam.rooms add foreign key (music_id) references jam.players(id);
create table jam.challenges (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references jam.rooms(id),
 text text not null check(length(text) between 1 and 1000), duration integer check(duration between 1 and 3600), active boolean not null default true
);
create table jam.assignments (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references jam.rooms(id), player_id uuid not null references jam.players(id),
 kind text not null check(kind in ('challenge','sacrifice')), text text not null, duration integer,
 status text not null default 'assigned' check(status in ('assigned','invited','running','failed','won','abandoned')),
 attempt_id uuid, witness_id uuid references jam.players(id), started_at timestamptz,
 bonus_rate integer, bonus_roll double precision, bonus_won boolean not null default false,
 created_at timestamptz not null default now()
);
create unique index one_assignment on jam.assignments(player_id) where status not in ('won','abandoned');
create table jam.attempts (
 id uuid primary key, assignment_id uuid not null references jam.assignments(id), witness_id uuid not null references jam.players(id),
 status text not null check(status in ('invited','running','declined','invalidated','won','failed')),
 started_at timestamptz, resolved_at timestamptz, in_time boolean
);
create table jam.requests (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references jam.rooms(id), player_id uuid not null references jam.players(id),
 kind text not null check(kind in ('song','skip')), text text not null,
 status text not null default 'pending' check(status in ('pending','queued','started','done','rejected')),
 reason text, created_at timestamptz not null default now(), resolved_at timestamptz
);
create unique index one_pending_song on jam.requests(player_id) where kind='song' and status='pending';
create unique index one_pending_skip on jam.requests(room_id) where kind='skip' and status='pending';
create table jam.ledger (
 id uuid primary key default gen_random_uuid(), player_id uuid not null references jam.players(id),
 source_id uuid not null, operation text not null, adds integer not null default 0, skip integer not null default 0,
 created_at timestamptz not null default now(), unique(source_id,operation)
);
create table jam.events (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references jam.rooms(id), recipient_id uuid references jam.players(id),
 kind text not null, body text not null, created_at timestamptz not null default now()
);
create index events_room_time on jam.events(room_id,created_at desc);
create table jam.subscriptions (
 id uuid primary key default gen_random_uuid(), player_id uuid not null references jam.players(id), endpoint text unique not null,
 p256dh text not null, auth text not null, created_at timestamptz not null default now()
);
create table jam.deliveries (
 id uuid primary key default gen_random_uuid(), event_id uuid not null references jam.events(id), subscription_id uuid not null references jam.subscriptions(id) on delete cascade,
 attempts integer not null default 0, available_at timestamptz not null default now(), lease uuid, sent_at timestamptz,
 last_error text, unique(event_id,subscription_id)
);
create table jam.receipts (
 user_id uuid not null, action_id uuid not null, kind text not null, payload jsonb not null,
 result jsonb not null, created_at timestamptz not null default now(), primary key(user_id,action_id)
);
create table jam.limits (key text primary key, starts_at timestamptz not null, count integer not null);

create function jam.emit(r uuid, recipient uuid, kind text, body text) returns void
language plpgsql set search_path = '' as $$
declare e uuid;
begin
 insert into jam.events(room_id,recipient_id,kind,body) values(r,recipient,kind,body) returning id into e;
 insert into jam.deliveries(event_id,subscription_id)
 select e,s.id from jam.subscriptions s join jam.players p on p.id=s.player_id
 where p.room_id=r and (recipient is null or p.id=recipient);
end $$;

create function jam.throttle(k text, maximum integer, seconds integer) returns boolean
language plpgsql set search_path = '' as $$
declare hits integer;
begin
 insert into jam.limits as l values(k,clock_timestamp(),1)
 on conflict(key) do update set
 count=case when l.starts_at < clock_timestamp()-make_interval(secs=>seconds) then 1 else l.count+1 end,
 starts_at=case when l.starts_at < clock_timestamp()-make_interval(secs=>seconds) then clock_timestamp() else l.starts_at end
 returning count into hits;
 return hits<=maximum;
end $$;

create function public.game_command(action_id uuid, kind text, payload jsonb default '{}') returns jsonb
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
 insert into jam.receipts(user_id,action_id,kind,payload,result) values(u,action_id,kind,payload,result);
 return result;
end $$;

create function public.game_state(room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jam.rooms; p jam.players;
begin
 select * into r from jam.rooms where id=room_id for share;
 select * into p from jam.players x where x.room_id=game_state.room_id and x.user_id=auth.uid();
 if p.id is null then raise exception 'Session expirée ou accès refusé. Récupérez votre profil.'; end if;
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

-- Dispatcher leases survive process crashes. Delivery is at least once; notification tags deduplicate display.
create function public.push_claim(batch_size integer default 25) returns jsonb
language sql security definer set search_path = '' as $$
 with selected as (
   select d.id from jam.deliveries d join jam.events e on e.id=d.event_id
   where d.sent_at is null and d.attempts<6 and d.available_at<=now() and e.created_at>now()-interval '24 hours'
   order by d.available_at for update of d skip locked limit least(greatest(batch_size,1),50)
 ), claimed as (
   update jam.deliveries d set lease=gen_random_uuid(),attempts=attempts+1,available_at=now()+interval '2 minutes'
   where id in(select id from selected) returning d.*
 ) select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'lease',d.lease,'attempts',d.attempts,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth,'eventId',e.id,'body',e.body)),'[]')
 from claimed d join jam.subscriptions s on s.id=d.subscription_id join jam.events e on e.id=d.event_id;
$$;
create function public.push_finish(delivery_id uuid, lease_id uuid, outcome text) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if outcome='gone' then
   delete from jam.subscriptions where id in(select subscription_id from jam.deliveries where id=delivery_id and lease=lease_id);
 else
   update jam.deliveries set sent_at=case when outcome='sent' then now() else null end,
     last_error=case when outcome='sent' then null else left(outcome,200) end,
     available_at=now()+make_interval(secs=>least(3600,30*power(2,attempts)::integer))
   where id=delivery_id and lease=lease_id;
 end if;
end $$;

revoke all on all tables in schema jam from public,anon,authenticated;
revoke all on all functions in schema jam from public,anon,authenticated;
revoke all on function public.game_command(uuid,text,jsonb),public.game_state(uuid),public.push_claim(integer),public.push_finish(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.game_command(uuid,text,jsonb),public.game_state(uuid) to authenticated;
grant execute on function public.push_claim(integer),public.push_finish(uuid,uuid,text) to service_role;

-- Defense in depth: no direct client table policies.
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='jam' loop
   execute format('alter table jam.%I enable row level security',t.tablename);
 end loop;
end $$;
