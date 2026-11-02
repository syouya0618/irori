-- Forward-only upgrade: retain regional preferences, article identities and notification receipts.
ALTER TABLE public.news_preferences DROP CONSTRAINT news_preferences_region_key_check;
ALTER TABLE public.news_preferences ADD CHECK(region_key IN ('sapporo','yokohama','kakegawa'));
ALTER TABLE public.news_articles DROP CONSTRAINT news_articles_region_key_check;
ALTER TABLE public.news_articles ADD CHECK(region_key IN ('sapporo','yokohama','kakegawa'));
-- Locate the existing URL-origin check without depending on PostgreSQL's generated suffix.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.news_articles'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%https://www.city.sapporo.jp/%' LOOP
  EXECUTE format('ALTER TABLE public.news_articles DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE public.news_articles ADD CHECK(
 (region_key='sapporo' AND url LIKE 'https://www.city.sapporo.jp/%') OR
 (region_key='yokohama' AND url LIKE 'https://www.city.yokohama.lg.jp/%') OR
 (region_key='kakegawa' AND url LIKE 'https://www.city.kakegawa.shizuoka.jp/%'));
ALTER TABLE public.news_articles ALTER COLUMN published_at DROP NOT NULL;
ALTER TABLE public.news_articles ADD COLUMN source_key text;
UPDATE public.news_articles SET source_key=region_key;
ALTER TABLE public.news_articles ALTER COLUMN source_key SET NOT NULL;
ALTER TABLE public.news_articles ADD CHECK(
 (region_key IN ('sapporo','yokohama') AND source_key=region_key) OR
 (region_key='kakegawa' AND source_key IN ('kakegawa-news','kakegawa-facilities','kakegawa-dining')));
ALTER TABLE public.news_source_runs DROP CONSTRAINT news_source_runs_region_key_check;
ALTER TABLE public.news_source_runs DROP CONSTRAINT news_source_runs_pkey;
ALTER TABLE public.news_source_runs ADD COLUMN source_key text;
UPDATE public.news_source_runs SET source_key=region_key;
ALTER TABLE public.news_source_runs ALTER COLUMN source_key SET NOT NULL;
ALTER TABLE public.news_source_runs ADD PRIMARY KEY(source_key);
ALTER TABLE public.news_source_runs ADD COLUMN last_error_at timestamptz;
ALTER TABLE public.news_source_runs ADD CHECK(
 (region_key IN ('sapporo','yokohama') AND source_key=region_key) OR
 (region_key='kakegawa' AND source_key IN ('kakegawa-news','kakegawa-facilities','kakegawa-dining')));
CREATE OR REPLACE FUNCTION public.save_news_preferences(p_region text,p_enabled boolean,p_version timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid;p public.news_preferences;
BEGIN
 SELECT household_id INTO h FROM public.profiles WHERE id=auth.uid();IF h IS NULL OR NOT irori_private.is_household_editor(h) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501';END IF;
 IF p_enabled IS NULL OR (p_region IS NOT NULL AND p_region NOT IN ('sapporo','yokohama','kakegawa')) OR (p_enabled AND p_region IS NULL) THEN RAISE EXCEPTION 'invalid region preference' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('news-pref:'||auth.uid()::text,0));
 IF NOT irori_private.is_household_editor(h) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.news_preferences WHERE user_id=auth.uid() FOR UPDATE;
 IF FOUND THEN
  IF (p.region_key,p.enabled) IS NOT DISTINCT FROM (p_region,p_enabled) THEN RETURN jsonb_build_object('status','replayed');END IF;
  IF p_version IS NULL OR p.updated_at<>p_version THEN RETURN jsonb_build_object('status','conflict');END IF;
  UPDATE public.news_preferences SET region_key=p_region,enabled=p_enabled,enabled_from=CASE WHEN p_enabled AND (NOT p.enabled OR p.region_key IS DISTINCT FROM p_region) THEN clock_timestamp() ELSE enabled_from END,updated_at=clock_timestamp() WHERE user_id=auth.uid();
 ELSE
  IF p_version IS NOT NULL THEN RAISE EXCEPTION 'preference unavailable' USING ERRCODE='42501';END IF;
  INSERT INTO public.news_preferences(user_id,region_key,enabled)VALUES(auth.uid(),p_region,p_enabled);
 END IF;
 RETURN jsonb_build_object('status','saved');
END;
$$;
REVOKE ALL ON FUNCTION public.save_news_preferences(text,boolean,timestamptz) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.save_news_preferences(text,boolean,timestamptz) TO authenticated;

-- p_region is retained for PostgREST compatibility; its value is now a fixed source key.
CREATE OR REPLACE FUNCTION public.claim_news_source(p_region text,p_now timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;
BEGIN
 r:=CASE WHEN p_region IN ('sapporo','yokohama') THEN p_region WHEN p_region IN ('kakegawa-news','kakegawa-facilities','kakegawa-dining') THEN 'kakegawa' END;
 IF r IS NULL OR p_now IS NULL OR NOT isfinite(p_now) THEN RETURN false;END IF;
 INSERT INTO public.news_source_runs(source_key,region_key,claimed_at)VALUES(p_region,r,p_now)
 ON CONFLICT(source_key) DO UPDATE SET claimed_at=excluded.claimed_at
 WHERE news_source_runs.claimed_at<=p_now-interval '5 minutes';
 RETURN FOUND;
END;
$$;
-- Compatibility scalar returns the newest success, including multi-feed regions.
CREATE OR REPLACE FUNCTION public.news_source_status() RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT max(s.last_success_at) FROM public.news_source_runs s JOIN public.news_preferences p ON p.region_key=s.region_key WHERE p.user_id=auth.uid() AND public.get_my_household_id() IS NOT NULL;
$$;
CREATE FUNCTION public.news_source_statuses() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('source_key',s.source_key,'region_key',s.region_key,'claimed_at',s.claimed_at,'last_success_at',s.last_success_at,'last_error_at',s.last_error_at) ORDER BY s.source_key),'[]'::jsonb)
 FROM public.news_source_runs s JOIN public.news_preferences p ON p.region_key=s.region_key WHERE p.user_id=auth.uid() AND public.get_my_household_id() IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.news_source_statuses() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.news_source_statuses() TO authenticated;
-- claim_news_source remains service_role-only; authenticated readers never write shared articles.

-- Older app releases omit source_key. Preserve their Sapporo/Yokohama writes for DB-first rollout.
CREATE FUNCTION irori_private.news_default_source() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.source_key IS NULL AND NEW.region_key IN ('sapporo','yokohama') THEN NEW.source_key:=NEW.region_key; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.news_default_source() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER news_default_source BEFORE INSERT ON public.news_articles FOR EACH ROW EXECUTE FUNCTION irori_private.news_default_source();
