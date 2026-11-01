CREATE TABLE public.custom_fields (
 id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES public.households(id), label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 80),
 value_type text NOT NULL CHECK(value_type IN ('number','boolean','text','datetime','choice')), options jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(options)='array'),
 archived boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(household_id,id)
);
ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_fields FROM PUBLIC,anon,authenticated;GRANT SELECT ON public.custom_fields TO authenticated;GRANT ALL ON public.custom_fields TO service_role;
CREATE POLICY custom_fields_select ON public.custom_fields FOR SELECT TO authenticated USING(irori_private.is_household_editor(household_id));
CREATE TABLE public.custom_records (
 id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES public.households(id),child_id uuid NOT NULL,field_id uuid NOT NULL,
 field_label text NOT NULL,value_type text NOT NULL,field_options jsonb NOT NULL,value jsonb NOT NULL,logged_at timestamptz NOT NULL CHECK(isfinite(logged_at)),memo text CHECK(length(memo)<=1000),voided boolean NOT NULL DEFAULT false,
 created_by uuid REFERENCES public.profiles(id),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 search_text text GENERATED ALWAYS AS (lower(field_label||' '||coalesce(value #>> '{}','')||' '||coalesce(memo,''))) STORED,
 FOREIGN KEY(household_id,child_id) REFERENCES public.children(household_id,id),FOREIGN KEY(household_id,field_id) REFERENCES public.custom_fields(household_id,id)
);
CREATE INDEX custom_records_child_time ON public.custom_records(household_id,child_id,logged_at DESC,id);
CREATE INDEX custom_records_field_time ON public.custom_records(household_id,child_id,field_id,logged_at DESC,id);
ALTER TABLE public.custom_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_records FROM PUBLIC,anon,authenticated;GRANT SELECT ON public.custom_records TO authenticated;GRANT ALL ON public.custom_records TO service_role;
CREATE POLICY custom_records_select ON public.custom_records FOR SELECT TO authenticated USING(irori_private.is_household_editor(household_id) AND child_id=irori_private.request_child(household_id));
CREATE FUNCTION public.save_custom_field(p_id uuid,p_version timestamptz,p_label text,p_type text,p_options jsonb,p_archived boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid;f public.custom_fields;exists_row boolean;
BEGIN
 SELECT household_id INTO h FROM public.profiles WHERE id=auth.uid();IF h IS NULL OR NOT irori_private.is_household_editor(h) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_label IS NULL OR length(btrim(p_label)) NOT BETWEEN 1 AND 80 OR p_type IS NULL OR p_type NOT IN ('number','boolean','text','datetime','choice') OR p_archived IS NULL OR p_options IS NULL OR jsonb_typeof(p_options)<>'array'
 THEN RAISE EXCEPTION 'invalid field' USING ERRCODE='22023';END IF;
 IF p_type='choice' THEN
  IF jsonb_array_length(p_options) NOT BETWEEN 1 AND 30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_options) q WHERE jsonb_typeof(q)<>'string' OR length(btrim(q#>>'{}')) NOT BETWEEN 1 AND 80)
   OR (SELECT count(DISTINCT q) FROM jsonb_array_elements(p_options) q)<>jsonb_array_length(p_options) THEN RAISE EXCEPTION 'invalid choices' USING ERRCODE='22023';END IF;
 ELSIF p_options<>'[]'::jsonb THEN RAISE EXCEPTION 'choices only allowed for choice type' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('custom-field:'||p_id::text,0));
 IF NOT irori_private.is_household_editor(h) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.custom_fields WHERE id=p_id FOR UPDATE;exists_row:=FOUND;
 IF exists_row THEN
  IF f.household_id<>h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501';END IF;
  IF f.value_type<>p_type OR f.options<>p_options THEN RAISE EXCEPTION 'field type and options are immutable; create a new field' USING ERRCODE='22023';END IF;
  IF (f.label,f.archived) IS NOT DISTINCT FROM (p_label,p_archived) THEN RETURN jsonb_build_object('status','replayed','field',to_jsonb(f));END IF;
  IF p_version IS NULL OR f.updated_at<>p_version THEN RETURN jsonb_build_object('status','conflict','field',to_jsonb(f));END IF;
  UPDATE public.custom_fields SET label=p_label,archived=p_archived,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO f;
 ELSE
  IF p_version IS NOT NULL THEN RAISE EXCEPTION 'field unavailable' USING ERRCODE='42501';END IF;
  INSERT INTO public.custom_fields(id,household_id,label,value_type,options,archived)VALUES(p_id,h,p_label,p_type,p_options,p_archived) RETURNING * INTO f;
 END IF;
 RETURN jsonb_build_object('status','saved','field',to_jsonb(f));
END;
$$;
CREATE FUNCTION irori_private.valid_custom_value(t text,opts jsonb,v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
 IF v IS NULL OR v='null'::jsonb THEN RETURN false;END IF;
 CASE t
 WHEN 'number' THEN RETURN jsonb_typeof(v)='number' AND (v#>>'{}')::numeric BETWEEN -1000000000 AND 1000000000;
 WHEN 'boolean' THEN RETURN jsonb_typeof(v)='boolean';
 WHEN 'text' THEN RETURN jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN 1 AND 1000;
 WHEN 'choice' THEN RETURN jsonb_typeof(v)='string' AND opts @> jsonb_build_array(v);
 WHEN 'datetime' THEN RETURN jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' AND isfinite((v#>>'{}')::timestamptz);
 ELSE RETURN false;END CASE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.valid_custom_value(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.save_custom_record(p_id uuid,p_child uuid,p_version timestamptz,p_field uuid,p_value jsonb,p_logged_at timestamptz,p_memo text,p_voided boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid;f public.custom_fields;r public.custom_records;exists_row boolean;
BEGIN
 h:=irori_private.sleep_child(p_child);
 IF p_id IS NULL OR p_field IS NULL OR p_logged_at IS NULL OR NOT isfinite(p_logged_at) OR p_voided IS NULL OR length(coalesce(p_memo,''))>1000 THEN RAISE EXCEPTION 'invalid custom record' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('custom-record:'||p_id::text,0));h:=irori_private.sleep_child(p_child);
 SELECT * INTO r FROM public.custom_records WHERE id=p_id FOR UPDATE;exists_row:=FOUND;
 IF exists_row AND (r.household_id<>h OR r.child_id<>p_child OR r.field_id<>p_field) THEN RAISE EXCEPTION 'record unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.custom_fields WHERE id=p_field AND household_id=h FOR SHARE;
 IF NOT FOUND OR (NOT exists_row AND f.archived) THEN RAISE EXCEPTION 'field unavailable' USING ERRCODE='42501';END IF;
 IF NOT irori_private.valid_custom_value(CASE WHEN exists_row THEN r.value_type ELSE f.value_type END,CASE WHEN exists_row THEN r.field_options ELSE f.options END,p_value) THEN RAISE EXCEPTION 'invalid typed value' USING ERRCODE='22023';END IF;
 IF exists_row THEN
  IF (r.value,r.logged_at,r.memo,r.voided) IS NOT DISTINCT FROM (p_value,p_logged_at,p_memo,p_voided) THEN RETURN jsonb_build_object('status','replayed','record',to_jsonb(r)-'search_text');END IF;
  IF p_version IS NULL OR r.updated_at<>p_version THEN RETURN jsonb_build_object('status','conflict','record',to_jsonb(r)-'search_text');END IF;
  UPDATE public.custom_records SET value=p_value,logged_at=p_logged_at,memo=p_memo,voided=p_voided,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO r;
 ELSE
  IF p_version IS NOT NULL THEN RAISE EXCEPTION 'record unavailable' USING ERRCODE='42501';END IF;
  INSERT INTO public.custom_records(id,household_id,child_id,field_id,field_label,value_type,field_options,value,logged_at,memo,voided,created_by)
   VALUES(p_id,h,p_child,p_field,f.label,f.value_type,f.options,p_value,p_logged_at,p_memo,p_voided,auth.uid()) RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('status','saved','record',to_jsonb(r)-'search_text');
END;
$$;
REVOKE ALL ON FUNCTION public.save_custom_field(uuid,timestamptz,text,text,jsonb,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.save_custom_record(uuid,uuid,timestamptz,uuid,jsonb,timestamptz,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_custom_field(uuid,timestamptz,text,text,jsonb,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_custom_record(uuid,uuid,timestamptz,uuid,jsonb,timestamptz,text,boolean) TO authenticated;

-- A single stable read statement exports a consistent snapshot; return no partial file on the size guard.
CREATE FUNCTION public.export_child_records(p_child uuid,p_from date DEFAULT NULL,p_to date DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid;from_at timestamptz;to_at timestamptz;sleeps jsonb;medical jsonb;custom jsonb;fields jsonb;n bigint;document jsonb;
BEGIN
 h:=irori_private.sleep_child(p_child);
 IF (p_from IS NOT NULL AND NOT isfinite(p_from)) OR (p_to IS NOT NULL AND NOT isfinite(p_to)) OR p_from>p_to THEN RAISE EXCEPTION 'invalid date range' USING ERRCODE='22023';END IF;
 from_at:=p_from::timestamp AT TIME ZONE 'Asia/Tokyo';to_at:=(p_to+1)::timestamp AT TIME ZONE 'Asia/Tokyo';
 SELECT (SELECT count(*) FROM public.sleep_sessions WHERE household_id=h AND child_id=p_child AND (from_at IS NULL OR started_at>=from_at) AND (to_at IS NULL OR started_at<to_at))+
  (SELECT count(*) FROM public.medical_records WHERE household_id=h AND child_id=p_child AND (p_from IS NULL OR scheduled_date>=p_from) AND (p_to IS NULL OR scheduled_date<=p_to))+
  (SELECT count(*) FROM public.custom_records WHERE household_id=h AND child_id=p_child AND (from_at IS NULL OR logged_at>=from_at) AND (to_at IS NULL OR logged_at<to_at)) INTO n;
 IF n>20000 THEN RAISE EXCEPTION 'export too large; narrow the date range' USING ERRCODE='54000';END IF;
 SELECT coalesce(jsonb_agg(irori_private.sleep_json(q) ORDER BY q.started_at,q.id),'[]') INTO sleeps FROM public.sleep_sessions q WHERE household_id=h AND child_id=p_child AND (from_at IS NULL OR started_at>=from_at) AND (to_at IS NULL OR started_at<to_at);
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.scheduled_date,q.id),'[]') INTO medical FROM public.medical_records q WHERE household_id=h AND child_id=p_child AND (p_from IS NULL OR scheduled_date>=p_from) AND (p_to IS NULL OR scheduled_date<=p_to);
 SELECT coalesce(jsonb_agg(to_jsonb(q)-'search_text' ORDER BY q.logged_at,q.id),'[]') INTO custom FROM public.custom_records q WHERE household_id=h AND child_id=p_child AND (from_at IS NULL OR logged_at>=from_at) AND (to_at IS NULL OR logged_at<to_at);
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at,q.id),'[]') INTO fields FROM public.custom_fields q WHERE household_id=h;
 document:=jsonb_build_object('custom_fields',fields,'schema_version',1,'child_id',p_child,'exported_at',statement_timestamp(),'from',p_from,'to',p_to,'complete',true,'row_count',n,'sleep',sleeps,'medical',medical,'custom',custom);
 IF octet_length(document::text)>3500000 THEN RAISE EXCEPTION 'export too large; narrow the date range' USING ERRCODE='54000';END IF;
 RETURN document;
END;
$$;
REVOKE ALL ON FUNCTION public.export_child_records(uuid,date,date) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.export_child_records(uuid,date,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.shared_child_snapshot(p_share_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.child_shares; c public.children; daily jsonb; health jsonb; diary jsonb; sleep_rows jsonb; medical_rows jsonb; custom_rows jsonb; valid_ms integer;
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
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO custom_rows FROM (
  SELECT field_label AS label,value#>>'{}' AS value,logged_at FROM public.custom_records WHERE household_id=s.household_id AND child_id=s.child_id AND s.allow_custom AND NOT voided
  ORDER BY logged_at DESC,id DESC LIMIT 100
 ) q;
 valid_ms := least(15000,coalesce(greatest(0,floor(extract(epoch FROM (s.expires_at-clock_timestamp()))*1000)),15000))::integer;
 RETURN jsonb_build_object('child_name',c.name,'birth_date',CASE WHEN s.allow_health THEN c.birth_date ELSE NULL END,
  'custom',custom_rows,'medical',medical_rows,'sleep',sleep_rows,'daily',daily,'health',health,'diary',diary,'allow_daily',s.allow_daily,'allow_diary',s.allow_diary,
  'allow_health',s.allow_health,'allow_custom',s.allow_custom,'expires_at',s.expires_at,'valid_for_ms',valid_ms,
  'window_note','日常7日・健康30日・日記8日。件数上限のある閲覧です');
END;
$$;
