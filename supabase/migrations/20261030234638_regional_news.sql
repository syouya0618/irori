CREATE TABLE public.news_preferences (
 user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
 region_key text CHECK(region_key IN ('sapporo','yokohama')),enabled boolean NOT NULL DEFAULT false,
 enabled_from timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(NOT enabled OR region_key IS NOT NULL)
);
ALTER TABLE public.news_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.news_preferences FROM PUBLIC,anon,authenticated;GRANT SELECT ON public.news_preferences TO authenticated;GRANT ALL ON public.news_preferences TO service_role;
CREATE POLICY news_preferences_select ON public.news_preferences FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.get_my_household_id() IS NOT NULL);
CREATE TABLE public.news_articles (
 region_key text NOT NULL CHECK(region_key IN ('sapporo','yokohama')),id text NOT NULL CHECK(id ~ '^[a-f0-9]{64}$'),title text NOT NULL CHECK(length(title) BETWEEN 1 AND 250),url text NOT NULL CHECK(length(url)<=2000),
 published_at timestamptz NOT NULL CHECK(isfinite(published_at)),first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),min_months integer,max_months integer,
 PRIMARY KEY(region_key,id),CHECK((min_months IS NULL)=(max_months IS NULL)),CHECK(min_months IS NULL OR (min_months>=0 AND max_months BETWEEN min_months AND 216)),
 CHECK((region_key='sapporo' AND url LIKE 'https://www.city.sapporo.jp/%') OR (region_key='yokohama' AND url LIKE 'https://www.city.yokohama.lg.jp/%'))
);
CREATE INDEX news_region_date ON public.news_articles(region_key,published_at DESC,id);
ALTER TABLE public.news_articles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.news_articles FROM PUBLIC,anon,authenticated;GRANT SELECT ON public.news_articles TO authenticated;GRANT ALL ON public.news_articles TO service_role;
CREATE POLICY news_articles_select ON public.news_articles FOR SELECT TO authenticated USING(public.get_my_household_id() IS NOT NULL AND region_key IN(SELECT p.region_key FROM public.news_preferences p WHERE p.user_id=auth.uid()));
CREATE TABLE public.news_source_runs(region_key text PRIMARY KEY CHECK(region_key IN ('sapporo','yokohama')),claimed_at timestamptz NOT NULL,last_success_at timestamptz);
CREATE TABLE public.news_batches(user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,day date NOT NULL,household_id uuid NOT NULL REFERENCES public.households(id),region_key text NOT NULL,article_ids text[] NOT NULL,PRIMARY KEY(user_id,day));
CREATE TABLE public.news_receipts(user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,region_key text NOT NULL,article_id text NOT NULL,PRIMARY KEY(user_id,region_key,article_id),FOREIGN KEY(region_key,article_id) REFERENCES public.news_articles(region_key,id));
CREATE TABLE public.news_deliveries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,household_id uuid NOT NULL REFERENCES public.households(id),region_key text NOT NULL,day date NOT NULL,
 subscription_id uuid REFERENCES public.push_subscriptions(id) ON DELETE SET NULL,article_ids text[] NOT NULL,sent_at timestamptz,accepted_at timestamptz,skipped_at timestamptz,
 UNIQUE(recipient_id,day,subscription_id),CHECK(cardinality(article_ids) BETWEEN 1 AND 10)
);
CREATE INDEX news_pending ON public.news_deliveries(day,id) WHERE sent_at IS NULL AND skipped_at IS NULL;
ALTER TABLE public.news_source_runs ENABLE ROW LEVEL SECURITY;ALTER TABLE public.news_batches ENABLE ROW LEVEL SECURITY;ALTER TABLE public.news_receipts ENABLE ROW LEVEL SECURITY;ALTER TABLE public.news_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.news_source_runs,public.news_batches,public.news_receipts,public.news_deliveries FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.news_source_runs,public.news_batches,public.news_receipts,public.news_deliveries TO service_role;
CREATE FUNCTION public.save_news_preferences(p_region text,p_enabled boolean,p_version timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid;p public.news_preferences;
BEGIN
 SELECT household_id INTO h FROM public.profiles WHERE id=auth.uid();IF h IS NULL OR NOT irori_private.is_household_editor(h) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501';END IF;
 IF p_enabled IS NULL OR (p_region IS NOT NULL AND p_region NOT IN ('sapporo','yokohama')) OR (p_enabled AND p_region IS NULL) THEN RAISE EXCEPTION 'invalid region preference' USING ERRCODE='22023';END IF;
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
CREATE FUNCTION irori_private.news_relevant(h uuid,a public.news_articles,d date) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT a.min_months IS NULL OR EXISTS(SELECT 1 FROM public.children c WHERE c.household_id=h AND c.birth_date IS NOT NULL AND c.birth_date<=d AND
  (extract(year FROM d)::integer*12+extract(month FROM d)::integer-extract(year FROM c.birth_date)::integer*12-extract(month FROM c.birth_date)::integer-
   CASE WHEN extract(day FROM d)<least(extract(day FROM c.birth_date),extract(day FROM (date_trunc('month',d::timestamp)+interval '1 month - 1 day'))) THEN 1 ELSE 0 END) BETWEEN a.min_months AND a.max_months);
$$;
REVOKE ALL ON FUNCTION irori_private.news_relevant(uuid,public.news_articles,date) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.claim_news_source(p_region text,p_now timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_region IS NULL OR p_region NOT IN ('sapporo','yokohama') OR p_now IS NULL OR NOT isfinite(p_now) THEN RETURN false;END IF;
 INSERT INTO public.news_source_runs(region_key,claimed_at)VALUES(p_region,p_now) ON CONFLICT(region_key)DO UPDATE SET claimed_at=excluded.claimed_at WHERE news_source_runs.claimed_at<=p_now-interval '5 minutes';
 RETURN FOUND;
END;
$$;
CREATE FUNCTION public.prepare_news_deliveries(p_now timestamptz) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d date:=(p_now AT TIME ZONE 'Asia/Tokyo')::date;t time:=(p_now AT TIME ZONE 'Asia/Tokyo')::time;candidate record;inserted integer;n integer:=0;
BEGIN
 UPDATE public.news_deliveries SET skipped_at=p_now WHERE day<d AND sent_at IS NULL AND skipped_at IS NULL;
 IF p_now IS NULL OR NOT isfinite(p_now) OR t<time '08:00' OR t>=time '08:15' THEN RETURN 0;END IF;
 FOR candidate IN
  SELECT p.user_id,p.region_key,profile.household_id,articles.ids FROM public.news_preferences p JOIN public.profiles profile ON profile.id=p.user_id
  CROSS JOIN LATERAL(SELECT array_agg(q.id ORDER BY q.published_at DESC,q.id) AS ids FROM(
   SELECT a.id,a.published_at FROM public.news_articles a WHERE a.region_key=p.region_key AND a.published_at>=greatest(p.enabled_from,p_now-interval '7 days') AND a.published_at<=p_now AND a.first_seen_at<=p_now
    AND irori_private.news_relevant(profile.household_id,a,d) AND NOT EXISTS(SELECT 1 FROM public.news_receipts r WHERE r.user_id=p.user_id AND r.region_key=a.region_key AND r.article_id=a.id)
   ORDER BY a.published_at DESC,a.id LIMIT 10)q)articles
  WHERE p.enabled AND profile.is_approved AND profile.role IN ('owner','member') AND profile.household_id IS NOT NULL AND cardinality(articles.ids)>0
   AND EXISTS(SELECT 1 FROM public.push_subscriptions s WHERE s.user_id=p.user_id)
   AND NOT EXISTS(SELECT 1 FROM public.news_batches b WHERE b.user_id=p.user_id AND b.day=d)
  ORDER BY p.user_id LIMIT 200
 LOOP
  INSERT INTO public.news_batches(user_id,day,household_id,region_key,article_ids)VALUES(candidate.user_id,d,candidate.household_id,candidate.region_key,candidate.ids)ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted>0 THEN INSERT INTO public.news_receipts(user_id,region_key,article_id)SELECT candidate.user_id,candidate.region_key,unnest(candidate.ids)ON CONFLICT DO NOTHING;END IF;
 END LOOP;
 INSERT INTO public.news_deliveries(recipient_id,household_id,region_key,day,subscription_id,article_ids)
 SELECT b.user_id,b.household_id,b.region_key,b.day,s.id,b.article_ids FROM public.news_batches b JOIN public.push_subscriptions s ON s.user_id=b.user_id WHERE b.day=d ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END;
$$;
CREATE FUNCTION public.claim_news_delivery(p_id uuid,p_now timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.news_deliveries;p public.news_preferences;profile public.profiles;d date:=(p_now AT TIME ZONE 'Asia/Tokyo')::date;t time:=(p_now AT TIME ZONE 'Asia/Tokyo')::time;
BEGIN
 SELECT * INTO r FROM public.news_deliveries WHERE id=p_id AND sent_at IS NULL AND skipped_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO p FROM public.news_preferences WHERE user_id=r.recipient_id FOR SHARE;
 SELECT * INTO profile FROM public.profiles WHERE id=r.recipient_id FOR SHARE;
 IF p_now IS NULL OR NOT isfinite(p_now) OR r.day<>d OR t<time '08:00' OR t>=time '08:15' OR NOT coalesce(p.enabled,false) OR p.region_key IS DISTINCT FROM r.region_key
  OR NOT coalesce(profile.is_approved,false) OR profile.role NOT IN ('owner','member') OR profile.household_id IS DISTINCT FROM r.household_id
  OR NOT EXISTS(SELECT 1 FROM public.push_subscriptions s WHERE s.id=r.subscription_id AND s.user_id=r.recipient_id)
  OR NOT EXISTS(SELECT 1 FROM public.news_articles a WHERE a.region_key=r.region_key AND a.id=ANY(r.article_ids) AND a.published_at>=p.enabled_from AND a.published_at<=p_now AND irori_private.news_relevant(r.household_id,a,d))
 THEN UPDATE public.news_deliveries SET skipped_at=clock_timestamp() WHERE id=r.id;RETURN NULL;END IF;
 UPDATE public.news_deliveries SET sent_at=p_now WHERE id=r.id;RETURN jsonb_build_object('id',r.id,'day',r.day);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_news_source(text,timestamptz),public.prepare_news_deliveries(timestamptz),public.claim_news_delivery(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_news_source(text,timestamptz),public.prepare_news_deliveries(timestamptz),public.claim_news_delivery(uuid,timestamptz) TO service_role;
CREATE FUNCTION public.news_source_status() RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT s.last_success_at FROM public.news_source_runs s JOIN public.news_preferences p ON p.region_key=s.region_key WHERE p.user_id=auth.uid() AND public.get_my_household_id() IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.news_source_status() FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.news_source_status() TO authenticated;
