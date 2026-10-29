-- Additive release: apply before deploying code. NULL is OFF for all existing users.
ALTER TABLE public.notification_preferences
  ADD COLUMN feeding_reminder_minutes integer,
  ADD CONSTRAINT chk_notification_prefs_feeding_minutes
    CHECK (feeding_reminder_minutes IS NULL OR feeding_reminder_minutes IN (5, 10, 15, 30));
GRANT INSERT (feeding_reminder_minutes), UPDATE (feeding_reminder_minutes)
  ON public.notification_preferences TO authenticated;
COMMENT ON COLUMN public.notification_preferences.feeding_reminder_minutes IS
  'Individual next-feeding reminder lead in minutes; NULL means OFF. Does not change event/digest preferences.';

ALTER TABLE public.notification_deliveries DROP CONSTRAINT chk_notification_deliveries_kind;
ALTER TABLE public.notification_deliveries ADD CONSTRAINT chk_notification_deliveries_kind
  CHECK (kind IN ('event', 'digest', 'feeding'));
ALTER TABLE public.notification_deliveries ADD CONSTRAINT chk_notification_deliveries_feeding_key
  CHECK (kind <> 'feeding' OR event_key IS NOT NULL);
-- Deliberately excludes dedupe_day: editing across JST midnight must not re-notify a sent cycle.
CREATE UNIQUE INDEX uq_notification_deliveries_feeding
  ON public.notification_deliveries (event_key, subscription_key) WHERE kind = 'feeding';
CREATE INDEX idx_notification_preferences_feeding ON public.notification_preferences (user_id)
  WHERE feeding_reminder_minutes IS NOT NULL;
CREATE INDEX idx_baby_logs_latest_nursing ON public.baby_logs (household_id, logged_at DESC, id DESC)
  WHERE log_type = 'feeding' AND (feeding_type IS NULL OR feeding_type <> 'pumped');

-- RPC uses explicit ON CONFLICT inference for the partial index. PostgREST table upsert
-- cannot infer a partial index from on_conflict columns alone (42P10).
CREATE FUNCTION public.enqueue_feeding_delivery(
  p_household_id uuid, p_log_id uuid, p_subscription_id uuid, p_scheduled_at timestamptz
) RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = public AS $$
  INSERT INTO public.notification_deliveries AS d
    (household_id, kind, event_key, subscription_id, subscription_key, dedupe_day, scheduled_at)
  SELECT p_household_id, 'feeding', p_log_id::text, s.id, s.id::text,
         (p_scheduled_at AT TIME ZONE 'Asia/Tokyo')::date, p_scheduled_at
  FROM public.push_subscriptions s
  JOIN public.profiles p ON p.id = s.user_id
  JOIN public.notification_preferences pref ON pref.user_id = p.id
  WHERE s.id = p_subscription_id AND p.household_id = p_household_id AND p.is_approved
    AND pref.feeding_reminder_minutes IS NOT NULL
    AND p_scheduled_at <= clock_timestamp()
    AND p_scheduled_at > clock_timestamp() - interval '15 minutes'
  ON CONFLICT (event_key, subscription_key) WHERE kind = 'feeding'
  DO UPDATE SET scheduled_at = EXCLUDED.scheduled_at, dedupe_day = EXCLUDED.dedupe_day,
                skipped_at = NULL, skip_reason = NULL
    WHERE d.sent_at IS NULL AND d.skip_reason IS DISTINCT FROM 'gone'
      AND d.household_id = EXCLUDED.household_id
      AND d.subscription_id IS NOT NULL
  RETURNING id;
$$;

-- Final pre-send read and conditional claim. Acquire the queue lock BEFORE reading
-- the current cycle: a single UPDATE/EXISTS can retain a stale MVCC snapshot
-- while waiting for another cron transaction (reproduced with two connections).
-- The application computes using computeNextFeeding; the equality below is a DB
-- invariant defending that snapshot, with the same millisecond precision as JS Date.
-- A change committed after this statement / Push acceptance cannot be retracted.
CREATE FUNCTION public.claim_feeding_delivery(
  p_delivery_id uuid, p_logged_at timestamptz, p_interval integer,
  p_lead integer, p_scheduled_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_claimed boolean;
BEGIN
  PERFORM 1 FROM public.notification_deliveries
    WHERE id = p_delivery_id AND kind = 'feeding'
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- VOLATILE PL/pgSQL uses a fresh READ COMMITTED snapshot for this statement,
  -- after lock contention has resolved. No external work occurs while holding it.
  WITH claimed AS (
    UPDATE public.notification_deliveries d SET sent_at = clock_timestamp()
    WHERE d.id = p_delivery_id AND d.kind = 'feeding'
      AND d.sent_at IS NULL AND d.skipped_at IS NULL
      AND d.scheduled_at = p_scheduled_at
      AND d.scheduled_at <= clock_timestamp()
      AND d.scheduled_at > clock_timestamp() - interval '15 minutes'
      AND EXISTS (
        SELECT 1 FROM public.push_subscriptions s
        JOIN public.profiles p ON p.id = s.user_id
        JOIN public.households h ON h.id = p.household_id
        JOIN public.notification_preferences pref ON pref.user_id = p.id
        JOIN public.baby_logs l ON l.household_id = h.id AND l.id::text = d.event_key
        WHERE s.id = d.subscription_id AND s.id::text = d.subscription_key
          AND p.household_id = d.household_id AND p.is_approved
          AND pref.feeding_reminder_minutes = p_lead AND p_lead IN (5, 10, 15, 30)
          AND h.feeding_interval_min = p_interval
          AND l.log_type = 'feeding' AND (l.feeding_type IS NULL OR l.feeding_type <> 'pumped')
          AND l.logged_at = p_logged_at
          AND d.scheduled_at = date_trunc('milliseconds', l.logged_at)
              + make_interval(mins => p_interval - p_lead)
          AND clock_timestamp() < l.logged_at + make_interval(mins => p_interval)
          AND NOT EXISTS (
            SELECT 1 FROM public.baby_logs newer
            WHERE newer.household_id = d.household_id AND newer.log_type = 'feeding'
              AND (newer.feeding_type IS NULL OR newer.feeding_type <> 'pumped')
              AND (newer.logged_at, newer.id) > (l.logged_at, l.id)
          )
      )
    RETURNING id
  ) SELECT EXISTS (SELECT 1 FROM claimed) INTO v_claimed;
  RETURN v_claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_feeding_delivery(uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_feeding_delivery(uuid, timestamptz, integer, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_feeding_delivery(uuid, uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_feeding_delivery(uuid, timestamptz, integer, integer, timestamptz) TO service_role;
