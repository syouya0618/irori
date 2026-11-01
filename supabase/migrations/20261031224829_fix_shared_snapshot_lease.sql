-- PostgreSQL greatest(0, NULL) is 0; handle an unbounded share before clamping.
-- Retain the authorization, locks, output projection and 15-second ceiling.
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
 valid_ms := CASE WHEN s.expires_at IS NULL THEN 15000
  ELSE least(15000,greatest(0,floor(extract(epoch FROM (s.expires_at-clock_timestamp()))*1000)))::integer END;
 RETURN jsonb_build_object('child_name',c.name,'birth_date',CASE WHEN s.allow_health THEN c.birth_date ELSE NULL END,
  'custom',custom_rows,'medical',medical_rows,'sleep',sleep_rows,'daily',daily,'health',health,'diary',diary,'allow_daily',s.allow_daily,'allow_diary',s.allow_diary,
  'allow_health',s.allow_health,'allow_custom',s.allow_custom,'expires_at',s.expires_at,'valid_for_ms',valid_ms,
  'window_note','日常7日・健康30日・日記8日。件数上限のある閲覧です');
END;
$$;
