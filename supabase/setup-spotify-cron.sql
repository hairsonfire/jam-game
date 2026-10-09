-- Reuses the existing Vault secrets from setup-push-cron.sql. No new paid service.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if exists(select 1 from cron.job where jobname='jam-spotify-sync') then perform cron.unschedule('jam-spotify-sync'); end if;
end $$;
select cron.schedule('jam-spotify-sync','* * * * *',$job$
 select net.http_post(
   url := (select decrypted_secret from vault.decrypted_secrets where name='jam_project_url')||'/functions/v1/spotify',
   headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='jam_push_cron_secret')),
   body := jsonb_build_object('roomId',r.id,'action','sync'), timeout_milliseconds := 60000
 ) from jam.rooms r join jam.spotify_connections c on c.room_id=r.id
 where (c.lease_until is null or c.lease_until<now()) and (c.retry_at is null or c.retry_at<now())
 and (r.last_activity_at>now()-interval '6 hours' or exists(select 1 from jam.spotify_jobs j where j.room_id=r.id and j.status in ('waiting','sending')))
 order by c.checked_at nulls first limit 10;
$job$);
commit;
