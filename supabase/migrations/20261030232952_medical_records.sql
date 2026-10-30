CREATE TABLE public.medical_records (
 id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES public.households(id), child_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('vaccination','checkup')), title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 100),
 dose integer CHECK(dose BETWEEN 1 AND 30), status text NOT NULL CHECK(status IN ('planned','completed','cancelled')),
 scheduled_date date NOT NULL CHECK(isfinite(scheduled_date)), completed_date date CHECK(isfinite(completed_date)),
 memo text CHECK(length(memo)<=1000), remind boolean NOT NULL DEFAULT false,
 source_key text NOT NULL CHECK(source_key IN ('jihs-2026-10-01','cfa-checkup-2026-07-23')),
 created_by uuid REFERENCES public.profiles(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(household_id,child_id) REFERENCES public.children(household_id,id),
 CHECK((status='completed')=(completed_date IS NOT NULL)), CHECK(kind='vaccination' OR dose IS NULL),
 CHECK((kind='vaccination' AND source_key='jihs-2026-10-01') OR (kind='checkup' AND source_key='cfa-checkup-2026-07-23'))
);
CREATE INDEX medical_child_date ON public.medical_records(household_id,child_id,scheduled_date DESC,id);
ALTER TABLE public.medical_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.medical_records FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.medical_records TO authenticated;
GRANT ALL ON public.medical_records TO service_role;
CREATE POLICY medical_select ON public.medical_records FOR SELECT TO authenticated USING(
 irori_private.is_household_editor(household_id) AND child_id=irori_private.request_child(household_id));
ALTER TABLE public.calendar_events ADD COLUMN medical_record_id uuid REFERENCES public.medical_records(id);
CREATE UNIQUE INDEX calendar_medical_record ON public.calendar_events(medical_record_id) WHERE medical_record_id IS NOT NULL;
-- Linked events are edited through the medical transaction. This invoker trigger does not trust request headers/configuration.
CREATE FUNCTION irori_private.guard_medical_calendar() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF current_user IN ('anon','authenticated') AND
  ((TG_OP<>'INSERT' AND OLD.medical_record_id IS NOT NULL) OR (TG_OP<>'DELETE' AND NEW.medical_record_id IS NOT NULL))
 THEN RAISE EXCEPTION 'edit linked event through medical records' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.guard_medical_calendar() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_medical_calendar BEFORE INSERT OR UPDATE OR DELETE ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION irori_private.guard_medical_calendar();
CREATE FUNCTION irori_private.guard_medical_reminder() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE h uuid; k text;
BEGIN
 IF TG_OP='DELETE' THEN h:=OLD.household_id;k:=OLD.event_uid;ELSE h:=NEW.household_id;k:=NEW.event_uid;END IF;
 IF current_user IN ('anon','authenticated') AND EXISTS(SELECT 1 FROM public.calendar_events WHERE household_id=h AND event_uid=k AND medical_record_id IS NOT NULL)
 THEN RAISE EXCEPTION 'edit medical reminder through medical records' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.guard_medical_reminder() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_medical_reminder BEFORE INSERT OR UPDATE OR DELETE ON public.event_reminders FOR EACH ROW EXECUTE FUNCTION irori_private.guard_medical_reminder();
CREATE FUNCTION public.save_medical_record(p_id uuid,p_child uuid,p_version timestamptz,p_value jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid; r public.medical_records; v public.medical_records; exists_row boolean; canonical jsonb; current_value jsonb;
BEGIN
 h:=irori_private.sleep_child(p_child);
 IF p_id IS NULL OR jsonb_typeof(p_value)<>'object' THEN RAISE EXCEPTION 'invalid medical input' USING ERRCODE='22023'; END IF;
 v:=jsonb_populate_record(NULL::public.medical_records,p_value);
 IF v.kind IS NULL OR v.kind NOT IN ('vaccination','checkup') OR v.status IS NULL OR v.status NOT IN ('planned','completed','cancelled') OR v.title IS NULL
  OR length(btrim(v.title)) NOT BETWEEN 1 AND 100 OR v.scheduled_date IS NULL OR NOT isfinite(v.scheduled_date) OR v.remind IS NULL OR v.source_key IS NULL
  OR (v.completed_date IS NOT NULL AND (NOT isfinite(v.completed_date) OR v.completed_date>(clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date))
 THEN RAISE EXCEPTION 'invalid medical input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('medical:'||p_id::text,0));h:=irori_private.sleep_child(p_child);
 SELECT * INTO r FROM public.medical_records WHERE id=p_id FOR UPDATE;exists_row:=FOUND;
 IF exists_row AND (r.household_id<>h OR r.child_id<>p_child) THEN RAISE EXCEPTION 'record unavailable' USING ERRCODE='42501'; END IF;
 canonical:=jsonb_build_array(v.kind,v.title,v.dose,v.status,v.scheduled_date,v.completed_date,v.memo,v.remind,v.source_key);
 IF exists_row THEN
  current_value:=jsonb_build_array(r.kind,r.title,r.dose,r.status,r.scheduled_date,r.completed_date,r.memo,r.remind,r.source_key);
  IF current_value=canonical THEN RETURN jsonb_build_object('status','replayed','record',to_jsonb(r));END IF;
  IF p_version IS NULL OR p_version<>r.updated_at THEN RETURN jsonb_build_object('status','conflict','record',to_jsonb(r));END IF;
  UPDATE public.medical_records SET kind=v.kind,title=v.title,dose=v.dose,status=v.status,scheduled_date=v.scheduled_date,completed_date=v.completed_date,
   memo=v.memo,remind=v.remind,source_key=v.source_key,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO r;
 ELSE
  IF p_version IS NOT NULL THEN RAISE EXCEPTION 'record unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO public.medical_records(id,household_id,child_id,kind,title,dose,status,scheduled_date,completed_date,memo,remind,source_key,created_by)
   VALUES(p_id,h,p_child,v.kind,v.title,v.dose,v.status,v.scheduled_date,v.completed_date,v.memo,v.remind,v.source_key,auth.uid()) RETURNING * INTO r;
 END IF;
 -- Remove this record's reminder before changing date/completion. Other events are untouched.
 DELETE FROM public.event_reminders WHERE household_id=h AND event_uid=p_id::text;
 IF exists_row THEN
  UPDATE public.calendar_events SET title=CASE WHEN r.status='completed' THEN '完了: ' WHEN r.status='cancelled' THEN '取消: ' ELSE '' END||r.title,
   start_date=r.scheduled_date,end_date=r.scheduled_date,updated_at=clock_timestamp() WHERE medical_record_id=p_id AND household_id=h;
 ELSE
  INSERT INTO public.calendar_events(id,household_id,child_id,medical_record_id,title,is_all_day,start_date,end_date,source,created_by)
   VALUES(p_id,h,p_child,p_id,r.title,true,r.scheduled_date,r.scheduled_date,'native',auth.uid());
 END IF;
 IF r.remind AND r.status='planned' THEN
  INSERT INTO public.event_reminders(household_id,event_uid,remind_kind,remind_minutes_before,created_by)
   VALUES(h,p_id::text,'prev_day_20',NULL,auth.uid());
 END IF;
 RETURN jsonb_build_object('status','saved','record',to_jsonb(r));
END;
$$;
REVOKE ALL ON FUNCTION public.save_medical_record(uuid,uuid,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_medical_record(uuid,uuid,timestamptz,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.shared_child_snapshot(p_share_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.child_shares; c public.children; daily jsonb; health jsonb; diary jsonb; sleep_rows jsonb; medical_rows jsonb; valid_ms integer;
BEGIN
 SELECT * INTO s FROM public.child_shares WHERE id=p_share_id AND viewer_id=auth.uid() FOR SHARE;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR (s.expires_at IS NOT NULL AND s.expires_at <= clock_timestamp())
  OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_approved)
  OR NOT EXISTS(SELECT 1 FROM public.invitations i WHERE i.id=s.invitation_id AND i.status='accepted'
   AND irori_private.is_household_owner_for_user(s.household_id,i.invited_by))
 THEN RAISE EXCEPTION 'sharing unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM public.children WHERE id=s.child_id AND household_id=s.household_id;
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO daily FROM (
  SELECT log_type,logged_at,feeding_type,amount_ml,diaper_type,duration_sec FROM public.baby_logs
  WHERE household_id=s.household_id AND child_id=s.child_id AND s.allow_daily
   AND log_type IN ('feeding','diaper') AND logged_at > clock_timestamp()-interval '7 days'
  ORDER BY logged_at DESC,id DESC LIMIT 200
 ) q;
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO health FROM (
  SELECT log_type,logged_at,temperature,weight_g,height_cm,memo FROM public.baby_logs
  WHERE household_id=s.household_id AND child_id=s.child_id AND s.allow_health
   AND log_type IN ('temperature','growth') AND logged_at > clock_timestamp()-interval '30 days'
  ORDER BY logged_at DESC,id DESC LIMIT 100
 ) q;
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO diary FROM (
  SELECT diary_date,content FROM public.baby_diaries WHERE household_id=s.household_id AND child_id=s.child_id AND s.allow_diary
   AND diary_date >= (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date-7 ORDER BY diary_date DESC LIMIT 8
 ) q;
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO sleep_rows FROM (
  SELECT started_at,ended_at FROM public.sleep_sessions WHERE household_id=s.household_id AND child_id=s.child_id AND s.allow_daily AND NOT voided
   AND started_at>clock_timestamp()-interval '7 days' ORDER BY started_at DESC,id DESC LIMIT 100
 ) q;
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO medical_rows FROM (
  SELECT kind,title,dose,status,scheduled_date,completed_date,source_key FROM public.medical_records WHERE household_id=s.household_id AND child_id=s.child_id AND s.allow_health
  ORDER BY scheduled_date DESC,id DESC LIMIT 100
 ) q;
 valid_ms := least(15000,coalesce(greatest(0,floor(extract(epoch FROM (s.expires_at-clock_timestamp()))*1000)),15000))::integer;
 RETURN jsonb_build_object('child_name',c.name,'birth_date',CASE WHEN s.allow_health THEN c.birth_date ELSE NULL END,
  'medical',medical_rows,'sleep',sleep_rows,'daily',daily,'health',health,'diary',diary,'allow_daily',s.allow_daily,'allow_diary',s.allow_diary,
  'allow_health',s.allow_health,'allow_custom',s.allow_custom,'expires_at',s.expires_at,'valid_for_ms',valid_ms,
  'window_note','日常7日・健康30日・日記8日。件数上限のある閲覧です');
END;
$$;
