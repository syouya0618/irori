-- Fresh projects may not auto-grant access to tables in public.
-- Make the existing application contract explicit; row ownership remains enforced by RLS.
-- households INSERT / DELETE / TRUNCATE remain revoked by 20261002100001.
-- https://supabase.com/docs/guides/api/securing-your-api
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calendar_events TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.households TO authenticated;
