-- Share song requests within the room; membership checks remain unchanged.
begin;
do $$
declare source text;
begin
 source := pg_get_functiondef('jam.game_state(uuid)'::regprocedure);
 if position('(x.status=''pending'' or x.player_id=p.id or p.id=r.music_id)' in source)=0 then
   raise exception 'Le filtre des demandes attendu est introuvable.';
 end if;
 source := replace(source, '(x.status=''pending'' or x.player_id=p.id or p.id=r.music_id)', '(x.kind=''song'' or x.status=''pending'' or x.player_id=p.id or p.id=r.music_id)');
 execute source;
end $$;
commit;
