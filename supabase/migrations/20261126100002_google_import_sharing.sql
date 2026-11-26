-- Only the person who connected a Google account may decide what it shares.
ALTER POLICY google_calendar_subscriptions_update ON public.google_calendar_subscriptions
  USING (
    household_id = public.get_my_household_id()
    AND EXISTS (
      SELECT 1 FROM public.google_connections c
      WHERE c.id = connection_id AND c.household_id = google_calendar_subscriptions.household_id
        AND c.user_id = auth.uid()
    )
  )
  WITH CHECK (
    household_id = public.get_my_household_id()
    AND EXISTS (
      SELECT 1 FROM public.google_connections c
      WHERE c.id = connection_id AND c.household_id = google_calendar_subscriptions.household_id
        AND c.user_id = auth.uid()
    )
  );

-- Serialize consent changes for the same household/calendar. A live import lease
-- must finish before the owner can disable a subscription; the sync worker also
-- claims only selected subscriptions and reads the token under that claim.
CREATE FUNCTION public.guard_google_subscription_sharing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_selected IS NOT DISTINCT FROM OLD.is_selected THEN RETURN NEW; END IF;
  END IF;
  IF OLD.sync_lease_until > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'calendar sync in progress' USING ERRCODE = '55P03';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    OLD.household_id::text || ':' || OLD.google_calendar_id, 0));
  IF TG_OP = 'UPDATE' THEN
    NEW.sync_token := NULL;
    NEW.last_synced_at := NULL;
    NEW.sync_lease_until := NULL;
    UPDATE public.google_connections SET last_synced_at = NULL
      WHERE id = OLD.connection_id AND household_id = OLD.household_id;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_google_subscription_sharing() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER google_subscription_sharing_guard
  BEFORE UPDATE OF is_selected OR DELETE ON public.google_calendar_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.guard_google_subscription_sharing();

CREATE FUNCTION public.cleanup_google_subscription_sharing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_selected OR NEW.is_selected IS NOT DISTINCT FROM OLD.is_selected THEN RETURN NEW; END IF;
  END IF;
  -- The BEFORE trigger serializes changes for this key. Never touch native rows
  -- or copies still selected by another connection in the household.
  IF NOT EXISTS (
    SELECT 1 FROM public.google_calendar_subscriptions s
    WHERE s.household_id = OLD.household_id AND s.google_calendar_id = OLD.google_calendar_id
      AND s.is_selected
  ) THEN
    DELETE FROM public.calendar_events
      WHERE household_id = OLD.household_id AND google_calendar_id = OLD.google_calendar_id AND source = 'google';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_google_subscription_sharing() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER google_subscription_sharing_cleanup
  AFTER UPDATE OF is_selected OR DELETE ON public.google_calendar_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_google_subscription_sharing();

-- Connection deletion must not race a leased export (which may be writing remotely).
CREATE FUNCTION public.guard_google_export_disconnect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_lease timestamptz;
BEGIN
  SELECT lease_until INTO v_lease FROM public.google_calendar_exports
    WHERE connection_id = OLD.id AND household_id = OLD.household_id FOR UPDATE;
  IF v_lease > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'calendar sync in progress' USING ERRCODE = '55P03';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_google_export_disconnect() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER google_export_disconnect_guard
  BEFORE DELETE ON public.google_connections
  FOR EACH ROW EXECUTE FUNCTION public.guard_google_export_disconnect();

-- Do not purge legacy data during deployment: old imports are reconciled on the
-- owner's next explicit selection change. This migration changes future behavior only.

-- Release barrier: the app can be deployed before DB migrations are applied.
-- This invoker function returns only a schema capability, never user data.
CREATE FUNCTION public.google_sharing_schema_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT true;
$$;
REVOKE ALL ON FUNCTION public.google_sharing_schema_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.google_sharing_schema_ready() TO authenticated, service_role;
