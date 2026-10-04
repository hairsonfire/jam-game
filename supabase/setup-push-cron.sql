-- Execute AFTER defining Vault secrets via the Supabase dashboard:
-- jam_project_url = https://PROJECT.supabase.co
-- jam_push_cron_secret = the SAME random secret as Edge secret PUSH_CRON_SECRET
-- Never commit secret values. This job retries notifications if no phone is open.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if exists(select 1 from cron.job where jobname='jam-push-retry') then
   perform cron.unschedule('jam-push-retry');
 end if;
end $$;
select cron.schedule('jam-push-retry','* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='jam_project_url') || '/functions/v1/push-dispatch',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='jam_push_cron_secret')),
    body := '{}'::jsonb
  ) where exists (
    select 1 from jam.deliveries d join jam.events e on e.id=d.event_id
    where d.sent_at is null and d.attempts<6 and d.available_at<=now() and e.created_at>now()-interval '24 hours'
  );
$job$);
