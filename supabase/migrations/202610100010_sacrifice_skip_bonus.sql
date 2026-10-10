-- Both successful kinds of trial use the current room bonus, once only.
begin;
do $$
declare source text;
begin
 source := pg_get_functiondef('jam.game_command(uuid,text,jsonb)'::regprocedure);
 if position('if a.kind=''challenge'' and not p.skip then' in source)=0 then
   raise exception 'La règle de bonus attendue est introuvable ; migration annulée.';
 end if;
 source := replace(source, 'if a.kind=''challenge'' and not p.skip then', 'if not p.skip then');
 execute source;
end $$;
commit;
