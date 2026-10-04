-- Run after migration 005 as postgres. No external service or paid plan.
begin;
create extension if not exists pg_cron;
do $$ begin
 if exists(select 1 from cron.job where jobname='jam-room-cleanup') then
   perform cron.unschedule('jam-room-cleanup');
 end if;
end $$;
-- Daily at 04:15 UTC. A paused database resumes this job when reactivated.
select cron.schedule('jam-room-cleanup','15 4 * * *',
  'select jam.purge_inactive_rooms();');
commit;
