-- Check both sides of a reminder move; a linked reminder cannot escape protection by changing its key.
CREATE OR REPLACE FUNCTION irori_private.guard_medical_reminder() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF current_user IN ('anon','authenticated') THEN
  IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.calendar_events WHERE household_id=OLD.household_id AND event_uid=OLD.event_uid AND medical_record_id IS NOT NULL)
  THEN RAISE EXCEPTION 'edit medical reminder through medical records' USING ERRCODE='42501';END IF;
  IF TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM public.calendar_events WHERE household_id=NEW.household_id AND event_uid=NEW.event_uid AND medical_record_id IS NOT NULL)
  THEN RAISE EXCEPTION 'edit medical reminder through medical records' USING ERRCODE='42501';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.guard_medical_reminder() FROM PUBLIC,anon,authenticated;
