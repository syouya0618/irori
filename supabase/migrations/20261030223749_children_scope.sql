-- Expand, backfill, validate, then cut over. No historical rows are removed.
CREATE TABLE public.children (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '' CHECK (char_length(name) <= 100),
  birth_date date,
  sex text CHECK (sex IN ('female','male')),
  is_legacy boolean NOT NULL DEFAULT false,
  feeding_interval_min integer NOT NULL DEFAULT 180 CHECK (feeding_interval_min BETWEEN 30 AND 720),
  bottle_default_ml smallint CHECK (bottle_default_ml BETWEEN 1 AND 999),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id)
);
CREATE UNIQUE INDEX children_one_legacy ON public.children(household_id) WHERE is_legacy;
ALTER TABLE public.children ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.children FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.children TO authenticated;
GRANT ALL ON public.children TO service_role;

CREATE FUNCTION irori_private.is_household_editor(h uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=(SELECT auth.uid())
    AND p.household_id=h AND p.is_approved AND p.role IN ('owner','member'));
$$;
REVOKE ALL ON FUNCTION irori_private.is_household_editor(uuid) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA irori_private TO authenticated;
GRANT EXECUTE ON FUNCTION irori_private.is_household_editor(uuid) TO authenticated;
CREATE POLICY children_select ON public.children FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
CREATE POLICY children_insert ON public.children FOR INSERT TO authenticated
  WITH CHECK (irori_private.is_household_editor(household_id) AND NOT is_legacy);
CREATE POLICY children_update ON public.children FOR UPDATE TO authenticated
  USING (irori_private.is_household_editor(household_id))
  WITH CHECK (irori_private.is_household_editor(household_id));

CREATE FUNCTION irori_private.sync_legacy_child() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO public.children(household_id,name,birth_date,is_legacy,feeding_interval_min,bottle_default_ml)
    VALUES(NEW.id,coalesce(NEW.baby_name,''),NEW.baby_birth_date,true,NEW.feeding_interval_min,NEW.bottle_default_ml)
    ON CONFLICT(household_id) WHERE is_legacy DO UPDATE SET
      name=EXCLUDED.name,birth_date=EXCLUDED.birth_date,
      feeding_interval_min=EXCLUDED.feeding_interval_min,bottle_default_ml=EXCLUDED.bottle_default_ml
    WHERE (children.name,children.birth_date,children.feeding_interval_min,children.bottle_default_ml)
      IS DISTINCT FROM (EXCLUDED.name,EXCLUDED.birth_date,EXCLUDED.feeding_interval_min,EXCLUDED.bottle_default_ml);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.sync_legacy_child() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER sync_legacy_child AFTER INSERT OR UPDATE OF baby_name,baby_birth_date,feeding_interval_min,bottle_default_ml
 ON public.households FOR EACH ROW EXECUTE FUNCTION irori_private.sync_legacy_child();
INSERT INTO public.children(household_id,name,birth_date,is_legacy,feeding_interval_min,bottle_default_ml)
 SELECT id,coalesce(baby_name,''),baby_birth_date,true,feeding_interval_min,bottle_default_ml FROM public.households;

ALTER TABLE public.baby_logs ADD COLUMN child_id uuid;
ALTER TABLE public.baby_diaries ADD COLUMN child_id uuid;
ALTER TABLE public.calendar_events ADD COLUMN child_id uuid;
ALTER TABLE public.feeding_amount_history ADD COLUMN child_id uuid;
ALTER TABLE public.baby_logs DISABLE TRIGGER trg_baby_logs_updated_at;
ALTER TABLE public.baby_diaries DISABLE TRIGGER trg_baby_diaries_updated_at;
UPDATE public.baby_logs l SET child_id=c.id FROM public.children c WHERE c.household_id=l.household_id AND c.is_legacy;
UPDATE public.baby_diaries d SET child_id=c.id FROM public.children c WHERE c.household_id=d.household_id AND c.is_legacy;
UPDATE public.feeding_amount_history h SET child_id=c.id FROM public.children c WHERE c.household_id=h.household_id AND c.is_legacy;
ALTER TABLE public.baby_logs ENABLE TRIGGER trg_baby_logs_updated_at;
ALTER TABLE public.baby_diaries ENABLE TRIGGER trg_baby_diaries_updated_at;
ALTER TABLE public.baby_logs ALTER COLUMN child_id SET NOT NULL;
ALTER TABLE public.baby_diaries ALTER COLUMN child_id SET NOT NULL;
ALTER TABLE public.feeding_amount_history ALTER COLUMN child_id SET NOT NULL;
ALTER TABLE public.baby_logs ADD CONSTRAINT baby_logs_child_fk FOREIGN KEY(household_id,child_id) REFERENCES public.children(household_id,id) NOT VALID;
ALTER TABLE public.baby_diaries ADD CONSTRAINT baby_diaries_child_fk FOREIGN KEY(household_id,child_id) REFERENCES public.children(household_id,id) NOT VALID;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_child_fk FOREIGN KEY(household_id,child_id) REFERENCES public.children(household_id,id) NOT VALID;
ALTER TABLE public.feeding_amount_history ADD CONSTRAINT feeding_history_child_fk FOREIGN KEY(household_id,child_id) REFERENCES public.children(household_id,id) NOT VALID;
ALTER TABLE public.baby_logs VALIDATE CONSTRAINT baby_logs_child_fk;
ALTER TABLE public.baby_diaries VALIDATE CONSTRAINT baby_diaries_child_fk;
ALTER TABLE public.calendar_events VALIDATE CONSTRAINT calendar_events_child_fk;
ALTER TABLE public.feeding_amount_history VALIDATE CONSTRAINT feeding_history_child_fk;
ALTER TABLE public.baby_diaries DROP CONSTRAINT uq_baby_diaries_household_date;
ALTER TABLE public.baby_diaries ADD CONSTRAINT uq_baby_diaries_child_date UNIQUE(household_id,child_id,diary_date);
ALTER TABLE public.feeding_amount_history DROP CONSTRAINT feeding_amount_history_pkey;
ALTER TABLE public.feeding_amount_history ADD PRIMARY KEY(user_id,household_id,child_id,feeding_type,amount_ml);
CREATE INDEX baby_logs_child_time ON public.baby_logs(household_id,child_id,logged_at DESC,id);
CREATE INDEX calendar_events_child ON public.calendar_events(household_id,child_id);

-- A caller-controlled header is a narrowing selector, never a grant. Missing header = legacy.
CREATE FUNCTION irori_private.request_child(h uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE selector text; result uuid;
BEGIN
  IF NOT irori_private.is_household_editor(h) THEN RETURN NULL; END IF;
  selector := nullif(current_setting('request.headers',true),'')::jsonb->>'x-irori-child';
  IF selector IS NULL THEN
    SELECT id INTO result FROM public.children WHERE household_id=h AND is_legacy;
  ELSIF selector ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO result FROM public.children WHERE household_id=h AND id=selector::uuid;
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.request_child(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION irori_private.request_child(uuid) TO authenticated;
CREATE FUNCTION irori_private.bind_child() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.household_id,NEW.child_id) IS DISTINCT FROM (OLD.household_id,OLD.child_id) THEN
    RAISE EXCEPTION 'record scope is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.child_id IS NULL THEN
    -- Deliberately do not use the selection header/cookie for old payloads.
    SELECT id INTO NEW.child_id FROM public.children WHERE household_id=NEW.household_id AND is_legacy;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.bind_child() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER bind_child BEFORE INSERT OR UPDATE ON public.baby_logs FOR EACH ROW EXECUTE FUNCTION irori_private.bind_child();
CREATE TRIGGER bind_child BEFORE INSERT OR UPDATE ON public.baby_diaries FOR EACH ROW EXECUTE FUNCTION irori_private.bind_child();
CREATE FUNCTION irori_private.guard_child_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF (NEW.id,NEW.household_id,NEW.is_legacy) IS DISTINCT FROM (OLD.id,OLD.household_id,OLD.is_legacy) THEN
    RAISE EXCEPTION 'child identity is immutable' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := clock_timestamp(); RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.guard_child_identity() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_child_identity BEFORE UPDATE ON public.children FOR EACH ROW EXECUTE FUNCTION irori_private.guard_child_identity();

-- Replace household-only policies with explicit editor + child scope checks.
DO $$ DECLARE t text; p record; BEGIN
 FOREACH t IN ARRAY ARRAY['baby_logs','baby_diaries'] LOOP
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
    EXECUTE format('DROP POLICY %I ON public.%I',p.policyname,t);
  END LOOP;
  EXECUTE format('CREATE POLICY child_select ON public.%I FOR SELECT TO authenticated USING (irori_private.is_household_editor(household_id) AND child_id=irori_private.request_child(household_id))',t);
  EXECUTE format('CREATE POLICY child_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (irori_private.is_household_editor(household_id) AND child_id=irori_private.request_child(household_id))',t);
  EXECUTE format('CREATE POLICY child_update ON public.%I FOR UPDATE TO authenticated USING (irori_private.is_household_editor(household_id) AND child_id=irori_private.request_child(household_id)) WITH CHECK (irori_private.is_household_editor(household_id) AND child_id=irori_private.request_child(household_id))',t);
  EXECUTE format('CREATE POLICY child_delete ON public.%I FOR DELETE TO authenticated USING (irori_private.is_household_editor(household_id) AND child_id=irori_private.request_child(household_id))',t);
 END LOOP;
END $$;
DROP POLICY feeding_amount_history_select ON public.feeding_amount_history;
CREATE POLICY feeding_amount_history_select ON public.feeding_amount_history FOR SELECT TO authenticated USING (
 user_id=(SELECT auth.uid()) AND irori_private.is_household_editor(household_id) AND child_id=irori_private.request_child(household_id));

CREATE OR REPLACE FUNCTION irori_private.remember_feeding_amount() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := auth.uid(); next_order bigint;
BEGIN
  IF NEW.log_type::text <> 'feeding'
    OR NEW.feeding_type::text NOT IN ('bottle', 'pumped', 'solid')
    OR NEW.amount_ml IS NULL OR actor IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.household_id, OLD.child_id, OLD.log_type, OLD.feeding_type, OLD.amount_ml)
       IS NOT DISTINCT FROM (NEW.household_id, NEW.child_id, NEW.log_type, NEW.feeding_type, NEW.amount_ml)
    THEN RETURN NEW; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = actor AND p.household_id = NEW.household_id AND p.is_approved AND p.role <> 'viewer')
  THEN RETURN NEW; END IF;
  -- Serialize a user's MRU so concurrent devices cannot retain six candidates.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    actor::text || ':' || NEW.household_id::text || ':' || NEW.child_id::text || ':' || NEW.feeding_type::text, 0));
  -- Recency is local to this scope; do not expose other households' activity via a global sequence.
  SELECT coalesce(max(h.use_order), 0) + 1 INTO next_order
    FROM public.feeding_amount_history h
    WHERE h.user_id = actor AND h.household_id = NEW.household_id AND h.child_id = NEW.child_id AND h.feeding_type = NEW.feeding_type::text;
  INSERT INTO public.feeding_amount_history(user_id, household_id, child_id, feeding_type, amount_ml, use_order)
    VALUES (actor, NEW.household_id, NEW.child_id, NEW.feeding_type::text, NEW.amount_ml, next_order)
    ON CONFLICT (user_id, household_id, child_id, feeding_type, amount_ml)
    DO UPDATE SET use_order = EXCLUDED.use_order;
  DELETE FROM public.feeding_amount_history h
    WHERE h.user_id = actor AND h.household_id = NEW.household_id AND h.child_id = NEW.child_id AND h.feeding_type = NEW.feeding_type::text
    AND h.amount_ml NOT IN (
      SELECT recent.amount_ml FROM public.feeding_amount_history recent
      WHERE recent.user_id = actor AND recent.household_id = NEW.household_id AND recent.child_id = NEW.child_id AND recent.feeding_type = NEW.feeding_type::text
      ORDER BY recent.use_order DESC LIMIT 5
    );
  RETURN NEW;
END;
$$;

-- Keep old clients' legacy settings coherent; changes to siblings never touch households.
CREATE FUNCTION irori_private.child_to_legacy_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.is_legacy THEN
  UPDATE public.households SET baby_name=NEW.name,baby_birth_date=NEW.birth_date,
   feeding_interval_min=NEW.feeding_interval_min,bottle_default_ml=NEW.bottle_default_ml
  WHERE id=NEW.household_id AND (baby_name,baby_birth_date,feeding_interval_min,bottle_default_ml)
    IS DISTINCT FROM (NEW.name,NEW.birth_date,NEW.feeding_interval_min,NEW.bottle_default_ml);
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.child_to_legacy_settings() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER child_to_legacy_settings AFTER UPDATE OF name,birth_date,feeding_interval_min,bottle_default_ml
 ON public.children FOR EACH ROW EXECUTE FUNCTION irori_private.child_to_legacy_settings();

CREATE OR REPLACE FUNCTION public.claim_feeding_delivery(
  p_delivery_id uuid, p_logged_at timestamptz, p_interval integer,
  p_lead integer, p_scheduled_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
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
        JOIN public.children c ON c.id = l.child_id AND c.household_id = h.id
        WHERE s.id = d.subscription_id AND s.id::text = d.subscription_key
          AND p.household_id = d.household_id AND p.is_approved AND p.role <> 'viewer'
          AND pref.feeding_reminder_minutes = p_lead AND p_lead IN (5, 10, 15, 30)
          AND c.feeding_interval_min = p_interval
          AND l.log_type = 'feeding' AND (l.feeding_type IS NULL OR l.feeding_type <> 'pumped')
          AND l.logged_at = p_logged_at
          AND d.scheduled_at = date_trunc('milliseconds', l.logged_at)
              + make_interval(mins => p_interval - p_lead)
          AND clock_timestamp() < l.logged_at + make_interval(mins => p_interval)
          AND NOT EXISTS (
            SELECT 1 FROM public.baby_logs newer
            WHERE newer.household_id = d.household_id AND newer.child_id=l.child_id AND newer.log_type = 'feeding'
              AND (newer.feeding_type IS NULL OR newer.feeding_type <> 'pumped')
              AND (newer.logged_at, newer.id) > (l.logged_at, l.id)
          )
      )
    RETURNING id
  ) SELECT EXISTS (SELECT 1 FROM claimed) INTO v_claimed;
  RETURN v_claimed;
END;
$$;
