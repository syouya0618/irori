CREATE TABLE public.sleep_sessions (
 id uuid PRIMARY KEY,
 household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
 child_id uuid NOT NULL,
 started_at timestamptz NOT NULL,
 ended_at timestamptz,
 started_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
 ended_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
 memo text CHECK (char_length(memo)<=1000),
 voided boolean NOT NULL DEFAULT false,
 create_request jsonb NOT NULL,
 stop_token uuid,
 stop_request jsonb,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(household_id,child_id) REFERENCES public.children(household_id,id),
 CHECK(isfinite(started_at) AND (ended_at IS NULL OR (isfinite(ended_at) AND ended_at>started_at AND ended_at<=started_at+interval '72 hours')))
);
CREATE UNIQUE INDEX sleep_one_active_child ON public.sleep_sessions(child_id) WHERE ended_at IS NULL AND NOT voided;
CREATE INDEX sleep_child_time ON public.sleep_sessions(household_id,child_id,started_at DESC,id);
ALTER TABLE public.sleep_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sleep_sessions FROM PUBLIC,anon,authenticated;
GRANT SELECT(id,household_id,child_id,started_at,ended_at,started_by,ended_by,memo,voided,updated_at,created_at) ON public.sleep_sessions TO authenticated;
GRANT ALL ON public.sleep_sessions TO service_role;
CREATE POLICY sleep_select ON public.sleep_sessions FOR SELECT TO authenticated USING (
 irori_private.is_household_editor(household_id) AND child_id=irori_private.request_child(household_id));

CREATE FUNCTION irori_private.sleep_json(s public.sleep_sessions) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT to_jsonb(s)-'create_request'-'stop_request'-'stop_token'; $$;
REVOKE ALL ON FUNCTION irori_private.sleep_json(public.sleep_sessions) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION irori_private.sleep_child(p_child uuid) RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid;
BEGIN
 SELECT household_id INTO h FROM public.children WHERE id=p_child;
 IF h IS NULL OR NOT irori_private.is_household_editor(h) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
 RETURN h;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.sleep_child(uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.start_sleep(p_id uuid,p_child uuid,p_start timestamptz DEFAULT NULL,p_end timestamptz DEFAULT NULL,p_memo text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid; s public.sleep_sessions; request jsonb; start_time timestamptz:=coalesce(p_start,clock_timestamp());
BEGIN
 h:=irori_private.sleep_child(p_child);
 IF p_id IS NULL OR NOT isfinite(start_time) OR start_time>clock_timestamp()+interval '5 minutes' OR char_length(coalesce(p_memo,''))>1000
  OR (p_end IS NOT NULL AND (NOT isfinite(p_end) OR p_end>clock_timestamp()+interval '5 minutes' OR p_end<=start_time OR p_end>start_time+interval '72 hours'))
 THEN RAISE EXCEPTION 'invalid sleep interval' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sleep:'||p_child::text,0));
 h:=irori_private.sleep_child(p_child); -- recheck live authority after any lock wait
 request:=jsonb_build_object('start',extract(epoch FROM p_start),'end',extract(epoch FROM p_end),'memo',p_memo);
 SELECT * INTO s FROM public.sleep_sessions WHERE id=p_id;
 IF FOUND THEN
  IF s.household_id<>h OR s.child_id<>p_child OR s.started_by IS DISTINCT FROM auth.uid() OR s.create_request<>request THEN
   RAISE EXCEPTION 'request id conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('status','replayed','session',irori_private.sleep_json(s));
 END IF;
 SELECT * INTO s FROM public.sleep_sessions WHERE child_id=p_child AND NOT voided AND
  started_at<coalesce(p_end,'infinity'::timestamptz) AND coalesce(ended_at,'infinity'::timestamptz)>start_time LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('status','conflict','session',irori_private.sleep_json(s)); END IF;
 INSERT INTO public.sleep_sessions(id,household_id,child_id,started_at,ended_at,started_by,ended_by,memo,create_request)
 VALUES(p_id,h,p_child,start_time,p_end,auth.uid(),CASE WHEN p_end IS NOT NULL THEN auth.uid() ELSE NULL END,p_memo,request) RETURNING * INTO s;
 RETURN jsonb_build_object('status','saved','session',irori_private.sleep_json(s));
END;
$$;
CREATE FUNCTION public.stop_sleep(p_id uuid,p_child uuid,p_version timestamptz,p_stop_id uuid,p_end timestamptz DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid; s public.sleep_sessions; end_time timestamptz:=coalesce(p_end,clock_timestamp()); request jsonb;
BEGIN
 h:=irori_private.sleep_child(p_child);
 IF p_stop_id IS NULL OR p_version IS NULL THEN RAISE EXCEPTION 'version and stop id required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sleep:'||p_child::text,0));
 h:=irori_private.sleep_child(p_child); -- recheck live authority after any lock wait
 SELECT * INTO s FROM public.sleep_sessions WHERE id=p_id AND child_id=p_child AND household_id=h FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'sleep unavailable' USING ERRCODE='42501'; END IF;
 request:=jsonb_build_object('end',extract(epoch FROM p_end));
 IF s.stop_token=p_stop_id THEN
  IF s.stop_request<>request THEN RAISE EXCEPTION 'request id conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('status','replayed','session',irori_private.sleep_json(s));
 END IF;
 IF s.ended_at IS NOT NULL OR s.voided OR s.updated_at<>p_version THEN RETURN jsonb_build_object('status','conflict','session',irori_private.sleep_json(s)); END IF;
 IF NOT isfinite(end_time) OR end_time<=s.started_at OR end_time>clock_timestamp()+interval '5 minutes' OR end_time>s.started_at+interval '72 hours' THEN RAISE EXCEPTION 'invalid sleep interval' USING ERRCODE='22023'; END IF;
 UPDATE public.sleep_sessions SET ended_at=end_time,ended_by=auth.uid(),stop_token=p_stop_id,stop_request=request,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
 RETURN jsonb_build_object('status','saved','session',irori_private.sleep_json(s));
END;
$$;
CREATE FUNCTION public.edit_sleep(p_id uuid,p_child uuid,p_version timestamptz,p_start timestamptz,p_end timestamptz,p_memo text DEFAULT NULL,p_voided boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid; s public.sleep_sessions;
BEGIN
 h:=irori_private.sleep_child(p_child);
 IF p_version IS NULL OR p_start IS NULL OR p_end IS NULL OR p_voided IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_end<=p_start OR p_end>p_start+interval '72 hours' OR p_end>clock_timestamp()+interval '5 minutes' OR char_length(coalesce(p_memo,''))>1000
 THEN RAISE EXCEPTION 'invalid sleep interval' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sleep:'||p_child::text,0));
 h:=irori_private.sleep_child(p_child); -- recheck live authority after any lock wait
 SELECT * INTO s FROM public.sleep_sessions WHERE id=p_id AND child_id=p_child AND household_id=h FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'sleep unavailable' USING ERRCODE='42501'; END IF;
 IF (s.started_at,s.ended_at,s.memo,s.voided) IS NOT DISTINCT FROM (p_start,p_end,p_memo,p_voided) THEN RETURN jsonb_build_object('status','replayed','session',irori_private.sleep_json(s)); END IF;
 IF s.updated_at<>p_version THEN RETURN jsonb_build_object('status','conflict','session',irori_private.sleep_json(s)); END IF;
 IF NOT p_voided AND EXISTS(SELECT 1 FROM public.sleep_sessions other WHERE other.child_id=p_child AND other.id<>s.id AND NOT other.voided
  AND other.started_at<p_end AND coalesce(other.ended_at,'infinity'::timestamptz)>p_start) THEN RAISE EXCEPTION 'sleep overlaps another record' USING ERRCODE='23514'; END IF;
 UPDATE public.sleep_sessions SET started_at=p_start,ended_at=p_end,memo=p_memo,voided=p_voided,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
 RETURN jsonb_build_object('status','saved','session',irori_private.sleep_json(s));
END;
$$;
REVOKE ALL ON FUNCTION public.start_sleep(uuid,uuid,timestamptz,timestamptz,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.stop_sleep(uuid,uuid,timestamptz,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.edit_sleep(uuid,uuid,timestamptz,timestamptz,timestamptz,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_sleep(uuid,uuid,timestamptz,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stop_sleep(uuid,uuid,timestamptz,uuid,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_sleep(uuid,uuid,timestamptz,timestamptz,timestamptz,text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.shared_child_snapshot(p_share_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.child_shares; c public.children; daily jsonb; health jsonb; diary jsonb; sleep_rows jsonb; valid_ms integer;
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
 valid_ms := least(15000,coalesce(greatest(0,floor(extract(epoch FROM (s.expires_at-clock_timestamp()))*1000)),15000))::integer;
 RETURN jsonb_build_object('child_name',c.name,'birth_date',CASE WHEN s.allow_health THEN c.birth_date ELSE NULL END,
  'sleep',sleep_rows,'daily',daily,'health',health,'diary',diary,'allow_daily',s.allow_daily,'allow_diary',s.allow_diary,
  'allow_health',s.allow_health,'allow_custom',s.allow_custom,'expires_at',s.expires_at,'valid_for_ms',valid_ms,
  'window_note','日常7日・健康30日・日記8日。件数上限のある閲覧です');
END;
$$;
