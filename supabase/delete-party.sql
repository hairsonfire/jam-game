-- À coller EN ENTIER dans SQL Editor, avec le rôle postgres.
-- 1. Renseigner le code et exécuter avec confirmer = false : aperçu seulement.
-- 2. Vérifier le nom affiché. Le recopier dans nom_attendu, mettre confirmer
--    à true et exécuter EN ENTIER pour supprimer définitivement cette soirée.
-- Aucune suppression de compte de connexion ni des autres soirées.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create temporary table jam_suppression_resultat (
  resultat text, nom text, code text, participants bigint,
  defis bigint, epreuves bigint, demandes bigint, notifications bigint
) on commit drop;

do $suppression$
declare
  code_soiree text := 'CODE_DE_LA_SOIREE'; -- À MODIFIER
  confirmer boolean := false;           -- true = suppression définitive
  nom_attendu text := '';               -- Nom exact affiché par l’aperçu
  soiree jam.rooms;
  joueurs uuid[];
begin
  code_soiree := upper(regexp_replace(btrim(code_soiree), '[[:space:]‐‑‒–—−-]', '', 'g'));
  if code_soiree = '' or code_soiree = 'CODE_DE_LA_SOIREE' then
    raise exception 'Renseignez le code de la soirée à supprimer.';
  end if;
  -- Même verrou que les actions du jeu : attendre les actions déjà en cours.
  select * into soiree from jam.rooms where code = code_soiree for update;
  if not found then raise exception 'Aucune soirée pour ce code. Rien n’a été supprimé.'; end if;
  select coalesce(array_agg(id), '{}'::uuid[]) into joueurs from jam.players where room_id = soiree.id;
  insert into jam_suppression_resultat select
    'APERÇU — aucune suppression', soiree.name, soiree.code, cardinality(joueurs),
    (select count(*) from jam.challenges where room_id = soiree.id),
    (select count(*) from jam.assignments where room_id = soiree.id),
    (select count(*) from jam.requests where room_id = soiree.id),
    (select count(*) from jam.events where room_id = soiree.id);
  if not confirmer then return; end if;
  if nom_attendu is distinct from soiree.name then
    raise exception 'Recopiez le nom exact de la soirée dans nom_attendu. Rien n’a été supprimé.';
  end if;

  delete from jam.deliveries where event_id in (select id from jam.events where room_id = soiree.id)
    or subscription_id in (select id from jam.subscriptions where player_id = any(joueurs));
  delete from jam.subscriptions where player_id = any(joueurs);
  delete from jam.events where room_id = soiree.id;
  delete from jam.attempts where assignment_id in (select id from jam.assignments where room_id = soiree.id);
  delete from jam.assignments where room_id = soiree.id;
  delete from jam.requests where room_id = soiree.id;
  delete from jam.ledger where player_id = any(joueurs);
  delete from jam.challenges where room_id = soiree.id;
  -- Conserver uniquement un reçu neutralisé pour empêcher un ancien clic
  -- rejoué de recréer la soirée ; enlever ses données et codes de récupération.
  update jam.receipts set payload = '{}'::jsonb,
    result = '{"error":"Cette soirée a été supprimée."}'::jsonb
    where coalesce(result->>'roomId', payload->>'roomId') = soiree.id::text;
  delete from jam.limits where key = 'recover-room:' || soiree.id::text
    or key in (select 'push:' || unnest(joueurs)::text);
  update jam.rooms set admin_id = null, music_id = null where id = soiree.id;
  delete from jam.players where room_id = soiree.id;
  delete from jam.rooms where id = soiree.id;
  update jam_suppression_resultat set resultat = 'SUPPRIMÉE — opération définitive';
end
$suppression$;

select * from jam_suppression_resultat;
commit;
