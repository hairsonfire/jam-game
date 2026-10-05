-- Change the existing checked command without changing its grants or other rules.
begin;
do $$
declare source text;
begin
 source := pg_get_functiondef('public.game_command(uuid,text,jsonb)'::regprocedure);
 if position('interval ''2 minutes''' in source)=0 then
   raise exception 'La règle d’abandon attendue est introuvable ; migration annulée.';
 end if;
 source := replace(source, 'interval ''2 minutes''', 'interval ''10 minutes''');
 source := replace(source, 'Attendez la fin des deux minutes.', 'Attendez la fin des dix minutes.');
 execute source;
 -- Extend only an abandonment cooldown that is still active at deployment.
 update jam.players set cooldown_until=cooldown_until+interval '8 minutes'
 where cooldown_until>now();
end $$;
commit;
