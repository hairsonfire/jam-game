-- Replace only the user-facing message in the installed command function.
DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.game_command(uuid,text,jsonb)'::regprocedure) INTO definition;
  EXECUTE replace(definition, 'Confirmez la suppression manuelle dans Spotify.', 'Confirmez la suppression manuelle dans votre application musicale.');
END;
$migration$;
