create function public.push_permission(room_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is null or not exists(select 1 from jam.players p where p.room_id=push_permission.room_id and p.user_id=auth.uid()) then return false; end if;
 return jam.throttle('dispatch:'||auth.uid(),20,60);
end $$;
revoke all on function public.push_permission(uuid) from public,anon;
grant execute on function public.push_permission(uuid) to authenticated;
