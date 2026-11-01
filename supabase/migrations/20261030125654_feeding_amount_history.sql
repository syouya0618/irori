-- Only committed input writes count. No backfill from another person's old logs.
CREATE SCHEMA IF NOT EXISTS irori_private;
REVOKE ALL ON SCHEMA irori_private FROM PUBLIC, anon, authenticated;

CREATE TABLE public.feeding_amount_history (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  feeding_type text NOT NULL CHECK (feeding_type IN ('bottle', 'pumped', 'solid')),
  amount_ml smallint NOT NULL CHECK (amount_ml BETWEEN 0 AND 999),
  use_order bigint NOT NULL,
  PRIMARY KEY (user_id, household_id, feeding_type, amount_ml)
);
ALTER TABLE public.feeding_amount_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feeding_amount_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.feeding_amount_history TO authenticated;
GRANT ALL ON public.feeding_amount_history TO service_role;
CREATE POLICY feeding_amount_history_select ON public.feeding_amount_history
  FOR SELECT TO authenticated USING (
    user_id = (SELECT auth.uid())
    AND household_id = (SELECT public.get_my_household_id())
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_approved)
  );

CREATE FUNCTION irori_private.remember_feeding_amount() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := auth.uid(); next_order bigint;
BEGIN
  IF NEW.log_type::text <> 'feeding'
    OR NEW.feeding_type::text NOT IN ('bottle', 'pumped', 'solid')
    OR NEW.amount_ml IS NULL OR actor IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.household_id, OLD.log_type, OLD.feeding_type, OLD.amount_ml)
       IS NOT DISTINCT FROM (NEW.household_id, NEW.log_type, NEW.feeding_type, NEW.amount_ml)
    THEN RETURN NEW; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = actor AND p.household_id = NEW.household_id AND p.is_approved AND p.role <> 'viewer')
  THEN RETURN NEW; END IF;
  -- Serialize a user's MRU so concurrent devices cannot retain six candidates.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    actor::text || ':' || NEW.household_id::text || ':' || NEW.feeding_type::text, 0));
  -- Recency is local to this scope; do not expose other households' activity via a global sequence.
  SELECT coalesce(max(h.use_order), 0) + 1 INTO next_order
    FROM public.feeding_amount_history h
    WHERE h.user_id = actor AND h.household_id = NEW.household_id AND h.feeding_type = NEW.feeding_type::text;
  INSERT INTO public.feeding_amount_history(user_id, household_id, feeding_type, amount_ml, use_order)
    VALUES (actor, NEW.household_id, NEW.feeding_type::text, NEW.amount_ml, next_order)
    ON CONFLICT (user_id, household_id, feeding_type, amount_ml)
    DO UPDATE SET use_order = EXCLUDED.use_order;
  DELETE FROM public.feeding_amount_history h
    WHERE h.user_id = actor AND h.household_id = NEW.household_id AND h.feeding_type = NEW.feeding_type::text
    AND h.amount_ml NOT IN (
      SELECT recent.amount_ml FROM public.feeding_amount_history recent
      WHERE recent.user_id = actor AND recent.household_id = NEW.household_id AND recent.feeding_type = NEW.feeding_type::text
      ORDER BY recent.use_order DESC LIMIT 5
    );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.remember_feeding_amount() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER remember_feeding_amount AFTER INSERT OR UPDATE ON public.baby_logs
  FOR EACH ROW EXECUTE FUNCTION irori_private.remember_feeding_amount();
