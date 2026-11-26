-- Durable identity outlives token revocation. Only a new opt-in by the same
-- household member and Google subject may resume work on the calendar.
CREATE TABLE public.google_managed_calendars (
  calendar_id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles ON DELETE CASCADE,
  google_account_id text NOT NULL,
  marker uuid NOT NULL,
  legacy boolean NOT NULL DEFAULT false,
  sync_token text,
  page_token text,
  window_start date,
  window_end date,
  scanned_on date,
  UNIQUE (household_id,user_id,google_account_id)
);
CREATE TABLE public.google_managed_events (
  calendar_id text NOT NULL REFERENCES public.google_managed_calendars ON DELETE CASCADE,
  event_id uuid NOT NULL,
  remote_id text NOT NULL,
  -- SQL NULL means no common ancestor. A confirmed deletion uses JSON null.
  retired_master boolean NOT NULL DEFAULT false,
  is_master boolean NOT NULL DEFAULT false,
  remote_bound boolean NOT NULL DEFAULT false,
  common jsonb,
  common_version timestamptz,
  etag text,
  pending boolean NOT NULL DEFAULT true,
  legacy_unverified boolean NOT NULL DEFAULT false,
  protected boolean NOT NULL DEFAULT false,
  observed jsonb,
  conflict_id uuid,
  conflict_version timestamptz,
  conflict_etag text,
  choice text CHECK (choice IN ('local','google')),
  intent jsonb,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (calendar_id, event_id),
  UNIQUE (calendar_id,remote_id)
);
CREATE INDEX google_managed_work ON public.google_managed_events(calendar_id,queued_at,event_id) WHERE pending;
CREATE TABLE public.google_event_deletions (
  household_id uuid NOT NULL REFERENCES public.households ON DELETE CASCADE,
  event_id uuid NOT NULL,
  PRIMARY KEY(household_id,event_id)
);
ALTER TABLE public.google_managed_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_managed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_event_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_managed_calendars,public.google_managed_events,public.google_event_deletions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.google_managed_calendars,public.google_managed_events,public.google_event_deletions TO service_role;

CREATE FUNCTION irori_private.google_event_doc(e public.calendar_events) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE WHEN e.source='native' AND e.child_id IS NULL AND e.medical_record_id IS NULL THEN
    jsonb_build_object('title',e.title,'timing',CASE WHEN e.is_all_day THEN
      jsonb_build_object('start',e.start_date,'end',e.end_date)
    ELSE jsonb_build_object('startAt',to_char(e.start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endAt',to_char((CASE WHEN e.end_at > e.start_at THEN e.end_at ELSE e.start_at + interval '1 minute' END) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)
    ELSE 'null'::jsonb END
$$;
-- A series master has its own logical ID. irori's series_id can equal its
-- first occurrence ID, so it cannot itself serve as a master binding key.
CREATE TABLE public.google_family_series(
 household_id uuid NOT NULL REFERENCES public.households ON DELETE CASCADE,
 series_id uuid NOT NULL,
 root_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 doc jsonb NOT NULL,
 retired_doc jsonb,
 version timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(household_id,series_id)
);
CREATE TABLE public.google_series_occurrences(
 household_id uuid NOT NULL,
 series_id uuid NOT NULL,
 anchor text NOT NULL,
 event_id uuid NOT NULL UNIQUE,
 PRIMARY KEY(household_id,series_id,anchor),
 FOREIGN KEY(household_id,series_id) REFERENCES public.google_family_series ON DELETE CASCADE
);
CREATE TABLE public.google_legacy_series(
 calendar_id text NOT NULL REFERENCES public.google_managed_calendars ON DELETE CASCADE,
 series_id uuid NOT NULL, PRIMARY KEY(calendar_id,series_id)
);
ALTER TABLE public.google_family_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_series_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_legacy_series ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_family_series,public.google_series_occurrences,public.google_legacy_series FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.google_family_series,public.google_series_occurrences,public.google_legacy_series TO service_role;

CREATE FUNCTION irori_private.queue_google_series() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO public.google_managed_events(calendar_id,event_id,remote_id,is_master)
 SELECT c.calendar_id,NEW.root_id,'s'||replace(NEW.root_id::text,'-',''),true
 FROM public.google_managed_calendars c WHERE c.household_id=NEW.household_id AND NOT EXISTS(
  SELECT 1 FROM public.google_legacy_series l WHERE l.calendar_id=c.calendar_id AND l.series_id=NEW.series_id)
 ON CONFLICT(calendar_id,event_id) DO UPDATE SET pending=true,queued_at=clock_timestamp();
 RETURN NULL;
END;
$$;
CREATE TRIGGER queue_google_series AFTER INSERT OR UPDATE OF doc ON public.google_family_series
FOR EACH ROW EXECUTE FUNCTION irori_private.queue_google_series();

CREATE FUNCTION irori_private.register_native_series(h uuid,s uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE first_event public.calendar_events; rule text; initial jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.google_family_series WHERE household_id=h AND series_id=s) THEN RETURN; END IF;
 SELECT * INTO first_event FROM public.calendar_events WHERE household_id=h AND series_id=s AND source='native'
 AND medical_record_id IS NULL AND child_id IS NULL ORDER BY start_date,start_at,id LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 -- Native series are finite, materialized insertions. RDATE preserves the actual
 -- dates (including month-end skips) without guessing the original frequency.
 SELECT CASE WHEN first_event.is_all_day THEN 'RDATE;VALUE=DATE:' ELSE 'RDATE:' END||
 string_agg(CASE WHEN first_event.is_all_day THEN to_char(start_date,'YYYYMMDD')
 ELSE to_char(start_at AT TIME ZONE 'UTC','YYYYMMDD"T"HH24MISS"Z"') END,',' ORDER BY start_date,start_at,id)
 INTO rule FROM public.calendar_events WHERE household_id=h AND series_id=s AND id<>first_event.id AND source='native'
 AND medical_record_id IS NULL AND child_id IS NULL AND is_all_day=first_event.is_all_day;
 initial:=irori_private.google_event_doc(first_event)||jsonb_build_object('rule',jsonb_build_object(
  'lines',jsonb_build_array(coalesce(rule,'RRULE:FREQ=DAILY;COUNT=1')),'startZone','Asia/Tokyo','endZone','Asia/Tokyo'));
 INSERT INTO public.google_family_series(household_id,series_id,doc) VALUES(h,s,initial) ON CONFLICT DO NOTHING;
 INSERT INTO public.google_series_occurrences(household_id,series_id,anchor,event_id)
 SELECT h,s,coalesce(irori_private.google_event_doc(e)#>>'{timing,start}',irori_private.google_event_doc(e)#>>'{timing,startAt}'),e.id
 FROM public.calendar_events e WHERE e.household_id=h AND e.series_id=s AND e.source='native' AND e.medical_record_id IS NULL AND e.child_id IS NULL
 ON CONFLICT DO NOTHING;
END;
$$;
CREATE FUNCTION irori_private.native_series_inserted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE k record;
BEGIN
 FOR k IN SELECT DISTINCT i.household_id,i.series_id FROM inserted_calendar_events i
  WHERE i.series_id IS NOT NULL AND i.source='native' AND i.medical_record_id IS NULL AND i.child_id IS NULL
 LOOP PERFORM irori_private.register_native_series(k.household_id,k.series_id); END LOOP;
 RETURN NULL;
END;
$$;
CREATE TRIGGER native_series_inserted AFTER INSERT ON public.calendar_events REFERENCING NEW TABLE AS inserted_calendar_events
FOR EACH STATEMENT EXECUTE FUNCTION irori_private.native_series_inserted();
REVOKE ALL ON FUNCTION irori_private.queue_google_series(),irori_private.native_series_inserted(),irori_private.register_native_series(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION irori_private.lock_calendar_series() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid; s uuid;
BEGIN
 IF TG_OP='DELETE' THEN s:=OLD.series_id; h:=OLD.household_id;
 ELSE s:=NEW.series_id; h:=NEW.household_id; END IF;
 IF TG_OP='UPDATE' AND (OLD.household_id,OLD.series_id) IS DISTINCT FROM (NEW.household_id,NEW.series_id)
 AND OLD.series_id IS NOT NULL THEN RAISE EXCEPTION 'series identity is immutable'; END IF;
 IF s IS NOT NULL THEN
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(h::text||s::text,0));
   IF TG_OP='INSERT' AND EXISTS (SELECT 1 FROM public.google_family_series WHERE household_id=h AND series_id=s AND doc='null') THEN
     RAISE EXCEPTION 'series was deleted' USING ERRCODE='40001';
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.lock_calendar_series() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER lock_calendar_series BEFORE INSERT OR UPDATE OR DELETE ON public.calendar_events
FOR EACH ROW EXECUTE FUNCTION irori_private.lock_calendar_series();

CREATE FUNCTION irori_private.queue_google_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.calendar_events;
BEGIN
  IF TG_OP='DELETE' THEN e:=OLD; ELSE e:=NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.household_id=NEW.household_id AND irori_private.google_event_doc(OLD)=irori_private.google_event_doc(NEW) THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' AND EXISTS (SELECT 1 FROM public.google_event_deletions WHERE household_id=e.household_id AND event_id=e.id) THEN
    RAISE EXCEPTION 'deleted event identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.households WHERE id=e.household_id) THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' AND e.source='native' AND EXISTS (
    SELECT 1 FROM public.google_managed_events m JOIN public.google_managed_calendars c USING(calendar_id)
    WHERE c.household_id=e.household_id AND m.event_id=e.id
  ) THEN
    INSERT INTO public.google_event_deletions VALUES(e.household_id,e.id) ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP<>'DELETE' AND e.series_id IS NOT NULL AND e.child_id IS NULL AND e.medical_record_id IS NULL
    AND e.end_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date-90 AND e.start_date <= (now() AT TIME ZONE 'Asia/Tokyo')::date+365 THEN
    UPDATE public.google_managed_events m SET pending=true FROM public.google_family_series s
     WHERE s.household_id=e.household_id AND s.series_id=e.series_id AND m.event_id=s.root_id
     AND m.common IS NULL AND m.conflict_id IS NULL;
  END IF;
  IF e.source='native' AND TG_OP <> 'DELETE' AND e.child_id IS NULL AND e.medical_record_id IS NULL
     AND e.end_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date-90 AND e.start_date <= (now() AT TIME ZONE 'Asia/Tokyo')::date+365 THEN
    INSERT INTO public.google_managed_events(calendar_id,event_id,remote_id)
    SELECT c.calendar_id,e.id,'irori'||replace(e.id::text,'-','') FROM public.google_managed_calendars c
    WHERE c.household_id=e.household_id
    ON CONFLICT(calendar_id,event_id) DO UPDATE SET pending=true,queued_at=clock_timestamp();
  ELSE
    UPDATE public.google_managed_events m SET pending=true,queued_at=clock_timestamp() FROM public.google_managed_calendars c
    WHERE c.calendar_id=m.calendar_id AND c.household_id=e.household_id AND m.event_id=e.id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.queue_google_event() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER queue_google_event AFTER INSERT OR UPDATE OR DELETE ON public.calendar_events
FOR EACH ROW EXECUTE FUNCTION irori_private.queue_google_event();

-- Seed a destination once, using the same deterministic ID as #278. All work
-- thereafter is caused by a mutation or an explicit remote observation.
CREATE FUNCTION irori_private.seed_google_calendar() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.google_managed_events(calendar_id,event_id,remote_id,legacy_unverified)
    SELECT NEW.calendar_id,e.id,'irori'||replace(e.id::text,'-',''),NEW.legacy FROM public.calendar_events e
    WHERE e.household_id=NEW.household_id AND e.source='native' AND e.child_id IS NULL AND e.medical_record_id IS NULL
      AND e.end_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date-90 AND e.start_date <= (now() AT TIME ZONE 'Asia/Tokyo')::date+365
    ON CONFLICT DO NOTHING;
  IF NEW.legacy THEN
    INSERT INTO public.google_legacy_series SELECT DISTINCT NEW.calendar_id,e.series_id FROM public.calendar_events e
    WHERE e.household_id=NEW.household_id AND e.series_id IS NOT NULL AND e.source='native' AND e.medical_record_id IS NULL AND e.child_id IS NULL ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO public.google_managed_events(calendar_id,event_id,remote_id,is_master)
  SELECT NEW.calendar_id,s.root_id,'s'||replace(s.root_id::text,'-',''),true FROM public.google_family_series s WHERE s.household_id=NEW.household_id
   AND NOT EXISTS (SELECT 1 FROM public.google_legacy_series l WHERE l.calendar_id=NEW.calendar_id AND l.series_id=s.series_id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.seed_google_calendar() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER seed_google_calendar AFTER INSERT ON public.google_managed_calendars FOR EACH ROW EXECUTE FUNCTION irori_private.seed_google_calendar();

INSERT INTO public.google_managed_calendars(calendar_id,household_id,user_id,google_account_id,marker,legacy)
 SELECT x.calendar_id,c.household_id,c.user_id,c.google_account_id,c.id,true FROM public.google_calendar_exports x
 JOIN public.google_connections c ON c.id=x.connection_id AND c.household_id=x.household_id WHERE x.calendar_id IS NOT NULL;

DO $$ DECLARE k record; BEGIN
 FOR k IN SELECT DISTINCT household_id,series_id FROM public.calendar_events WHERE source='native' AND series_id IS NOT NULL AND child_id IS NULL AND medical_record_id IS NULL
 LOOP PERFORM irori_private.register_native_series(k.household_id,k.series_id); END LOOP;
END $$;

-- Each RPC locks the exact active lease and rechecks current membership. This
-- serializes cursor commits, conflict resolution, stop and queued worker retries.
CREATE FUNCTION irori_private.require_google_lease(p_calendar text,p_lease timestamptz) RETURNS public.google_managed_calendars
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE c public.google_managed_calendars;
BEGIN
 SELECT m.* INTO STRICT c FROM public.google_managed_calendars m
 JOIN public.google_calendar_exports x ON x.calendar_id=m.calendar_id AND x.household_id=m.household_id
 JOIN public.google_connections g ON g.id=x.connection_id AND g.household_id=m.household_id AND g.user_id=m.user_id AND g.google_account_id=m.google_account_id
 JOIN public.profiles p ON p.id=m.user_id AND p.household_id=m.household_id AND p.is_approved AND p.role<>'viewer'
 WHERE m.calendar_id=p_calendar AND x.enabled AND x.bidirectional AND x.lease_until=p_lease AND p_lease>clock_timestamp() FOR UPDATE OF x;
 RETURN c;
END;
$$;

-- Merge title and the entire temporal interval as independent fields. NULL
-- result represents an unresolved conflict, JSON null means explicit deletion.
CREATE FUNCTION irori_private.google_merge(b jsonb,l jsonb,r jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; merged jsonb:='{}';
BEGIN
 IF l=r THEN RETURN l; END IF;
 IF b IS NULL THEN RETURN NULL; END IF;
 IF l=b THEN RETURN r; END IF;
 IF r=b THEN RETURN l; END IF;
 IF l='null' OR r='null' OR b='null' THEN RETURN NULL; END IF;
 FOREACH k IN ARRAY ARRAY['title','timing','rule'] LOOP
   IF NOT (l ? k OR r ? k OR b ? k) THEN CONTINUE; END IF;
   IF l->k=r->k OR r->k=b->k THEN merged:=merged||jsonb_build_object(k,l->k);
   ELSIF l->k=b->k THEN merged:=merged||jsonb_build_object(k,r->k);
   ELSE RETURN NULL;
   END IF;
 END LOOP;
 RETURN merged;
END;
$$;

CREATE TABLE public.google_retired_event_ids (
  calendar_id text NOT NULL REFERENCES public.google_managed_calendars ON DELETE CASCADE,
  remote_id text NOT NULL, PRIMARY KEY(calendar_id,remote_id)
);
ALTER TABLE public.google_retired_event_ids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_retired_event_ids FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.google_retired_event_ids TO service_role;

CREATE FUNCTION irori_private.google_inherited_instance(master jsonb,anchor text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE t jsonb:=master->'timing'; result jsonb; duration interval;
BEGIN
 IF t ? 'start' AND length(anchor)=10 THEN
  result:=jsonb_build_object('start',anchor,'end',anchor::date+((t->>'end')::date-(t->>'start')::date));
 ELSIF t ? 'startAt' AND length(anchor)>10 THEN
  duration:=(t->>'endAt')::timestamptz-(t->>'startAt')::timestamptz;
  result:=jsonb_build_object('startAt',anchor,'endAt',to_char((anchor::timestamptz+duration) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 ELSE RETURN NULL; END IF;
 RETURN jsonb_build_object('title',master->>'title','timing',result);
END;
$$;
REVOKE ALL ON FUNCTION irori_private.google_inherited_instance(jsonb,text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.google_managed_exchange(p_calendar text,p_lease timestamptz,p_remote text,
  p_state text,p_doc jsonb,p_etag text,p_legacy uuid DEFAULT NULL,p_series uuid DEFAULT NULL,p_master boolean DEFAULT false,p_anchor text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
 c public.google_managed_calendars; m public.google_managed_events; e public.calendar_events;
 local_doc jsonb; remote_doc jsonb; merged jsonb; timing jsonb; has_event boolean; reversible boolean:=false;
 start_at_value timestamptz; end_at_value timestamptz; is_day boolean; start_day date; end_day date;
 new_remote boolean:=false; retired_instance boolean:=false; family public.google_family_series; anchor_id uuid;
BEGIN
 c:=irori_private.require_google_lease(p_calendar,p_lease);
 IF p_state NOT IN ('present','cancelled','missing','protected') OR p_state IS NULL OR nullif(p_remote,'') IS NULL THEN RAISE EXCEPTION 'invalid observation'; END IF;
 IF p_state='present' AND (p_etag IS NULL OR jsonb_typeof(p_doc) IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'incomplete observation'; END IF;
 remote_doc:=CASE WHEN p_state='present' THEN p_doc ELSE 'null'::jsonb END;
 IF EXISTS (SELECT 1 FROM public.google_retired_event_ids WHERE calendar_id=p_calendar AND remote_id=p_remote) THEN RETURN jsonb_build_object('action','none'); END IF;
 SELECT * INTO m FROM public.google_managed_events WHERE calendar_id=p_calendar AND remote_id=p_remote FOR UPDATE;
 IF NOT FOUND THEN
   IF p_state<>'present' AND NOT (p_state='cancelled' AND p_series IS NOT NULL AND p_anchor IS NOT NULL) THEN RETURN jsonb_build_object('action','none'); END IF;
   IF p_master THEN
     IF p_series IS NULL OR NOT (remote_doc ? 'rule') THEN RAISE EXCEPTION 'invalid master'; END IF;
     -- Seed the origin binding first so the master trigger only fans out to other calendars.
     anchor_id:=gen_random_uuid();
     INSERT INTO public.google_managed_events(calendar_id,event_id,remote_id,is_master)
       VALUES(p_calendar,anchor_id,p_remote,true) RETURNING * INTO m;
     INSERT INTO public.google_family_series(household_id,series_id,root_id,doc) VALUES(c.household_id,p_series,anchor_id,remote_doc);
   ELSE
     IF p_series IS NOT NULL AND p_anchor IS NOT NULL THEN
       INSERT INTO public.google_series_occurrences(household_id,series_id,anchor,event_id) VALUES(c.household_id,p_series,p_anchor,gen_random_uuid())
       ON CONFLICT(household_id,series_id,anchor) DO UPDATE SET anchor=excluded.anchor RETURNING event_id INTO anchor_id;
       SELECT * INTO m FROM public.google_managed_events WHERE calendar_id=p_calendar AND event_id=anchor_id FOR UPDATE;
       IF FOUND THEN
         IF m.common IS NOT NULL OR m.intent IS NOT NULL OR m.legacy_unverified THEN RAISE EXCEPTION 'ambiguous occurrence identity'; END IF;
         UPDATE public.google_managed_events SET remote_id=p_remote,remote_bound=true WHERE calendar_id=p_calendar AND event_id=anchor_id RETURNING * INTO m;
       END IF;
     END IF;
     IF m.event_id IS NULL THEN
       INSERT INTO public.google_managed_events(calendar_id,event_id,remote_id) VALUES(p_calendar,coalesce(anchor_id,p_legacy,gen_random_uuid()),p_remote) RETURNING * INTO m;
       IF p_anchor IS NOT NULL THEN UPDATE public.google_managed_events SET remote_bound=true WHERE calendar_id=p_calendar AND event_id=m.event_id; END IF;
     END IF;
     new_remote:=p_legacy IS NULL;
   END IF;
 END IF;
 IF m.is_master THEN
   SELECT * INTO STRICT family FROM public.google_family_series WHERE root_id=m.event_id AND household_id=c.household_id FOR UPDATE;
   local_doc:=family.doc; has_event:=family.doc<>'null'; e.updated_at:=family.version;
 ELSE
   SELECT * INTO e FROM public.calendar_events WHERE id=m.event_id FOR UPDATE;
   has_event:=FOUND;
   local_doc:=CASE WHEN has_event THEN irori_private.google_event_doc(e) ELSE 'null'::jsonb END;
 END IF;
 IF m.is_master AND EXISTS(SELECT 1 FROM public.calendar_events priv WHERE priv.household_id=c.household_id AND priv.series_id=family.series_id
     AND (priv.child_id IS NOT NULL OR priv.medical_record_id IS NOT NULL)) THEN
   UPDATE public.google_managed_events SET pending=false WHERE calendar_id=p_calendar AND event_id=m.event_id;
   RETURN jsonb_build_object('action','none');
 END IF;
 IF NOT m.is_master AND has_event AND (e.household_id<>c.household_id OR e.source<>'native' OR e.child_id IS NOT NULL OR e.medical_record_id IS NOT NULL) THEN
   UPDATE public.google_managed_events SET pending=false,choice=NULL,observed=NULL,conflict_id=NULL WHERE calendar_id=p_calendar AND event_id=m.event_id;
   RETURN jsonb_build_object('action','none');
 END IF;
 IF NOT m.is_master AND p_series IS NOT NULL THEN
   SELECT * INTO family FROM public.google_family_series WHERE household_id=c.household_id AND series_id=p_series;
   retired_instance:=family.doc='null' AND family.retired_doc IS NOT NULL;
 END IF;
 -- If a response was lost, an observed copy of our durable write intent is a
 -- common ancestor, even when the local event changed again in the meantime.
 IF m.intent IS NOT NULL AND remote_doc=m.intent AND p_state IN ('present','cancelled') THEN m.common:=m.intent; END IF;
 IF p_state='protected' THEN merged:=NULL;
 ELSIF m.conflict_id IS NOT NULL AND m.choice IS NOT NULL AND m.conflict_version IS NOT DISTINCT FROM e.updated_at
     AND m.conflict_etag IS NOT DISTINCT FROM p_etag AND m.observed=remote_doc THEN
   merged:=CASE WHEN m.choice='local' THEN local_doc ELSE remote_doc END;
   reversible:=true;
 ELSIF p_state='protected' OR (p_state='missing' AND m.common IS NOT NULL AND m.common<>'null') THEN merged:=NULL;
 ELSIF retired_instance AND NOT has_event AND m.common IS NULL AND p_state='present' THEN
   -- A never-observed override may carry independent edits, even if its title matches the parent.
   merged:=NULL;
 ELSIF p_anchor IS NOT NULL AND m.common IS NULL AND EXISTS (SELECT 1 FROM public.google_event_deletions WHERE household_id=c.household_id AND event_id=m.event_id) THEN
   SELECT irori_private.google_merge(irori_private.google_inherited_instance(s.doc,p_anchor),local_doc,remote_doc) INTO merged
    FROM public.google_family_series s WHERE s.series_id=p_series AND s.household_id=c.household_id;
 ELSIF new_remote AND NOT has_event THEN merged:=remote_doc;
 ELSIF new_remote AND p_anchor IS NOT NULL AND m.common IS NULL AND local_doc<>remote_doc THEN
   SELECT irori_private.google_merge(irori_private.google_inherited_instance(s.doc,p_anchor),local_doc,remote_doc) INTO merged
   FROM public.google_family_series s WHERE s.series_id=p_series AND s.household_id=c.household_id;
 ELSIF m.common IS NULL AND p_state='missing' AND p_legacy IS NULL AND NOT m.legacy_unverified THEN merged:=local_doc;
 ELSIF m.common='null' AND remote_doc<>'null' THEN merged:=NULL;
 ELSE merged:=irori_private.google_merge(m.common,local_doc,remote_doc);
 END IF;
 -- Never re-create a cancelled Google ID, including after an explicit resolution.
 IF NOT reversible AND ((p_state='cancelled' AND has_event AND m.common IS NOT NULL AND m.common_version IS DISTINCT FROM e.updated_at)
    OR (NOT has_event AND p_state='present' AND m.common IS NOT NULL AND m.etag IS DISTINCT FROM p_etag AND m.intent IS DISTINCT FROM remote_doc)) THEN
   merged:=NULL;
 END IF;
 -- A parent's ETag does not cover independent edits to individual exceptions.
 IF m.is_master AND m.common IS NOT NULL AND local_doc<>remote_doc AND
    (remote_doc='null' AND NOT reversible) THEN
    merged:=NULL;
 END IF;
 -- A physical parent DELETE would bypass the individual exception ETags.
 -- Retain the generator and cancel visible occurrences through their own CAS.
 IF m.is_master AND merged='null' AND p_state='present' THEN
   UPDATE public.google_managed_events SET retired_master=true,pending=false,common=remote_doc,etag=p_etag,
    conflict_id=NULL,choice=NULL,intent=NULL WHERE calendar_id=p_calendar AND event_id=m.event_id;
   IF NOT m.retired_master THEN
     UPDATE public.google_managed_events child SET pending=true FROM public.google_series_occurrences o
      WHERE child.calendar_id=p_calendar AND child.event_id=o.event_id AND o.household_id=c.household_id AND o.series_id=family.series_id;
   END IF;
   RETURN jsonb_build_object('action','none');
 END IF;
 IF reversible AND p_state IN ('cancelled','missing') AND merged<>'null' THEN
   INSERT INTO public.google_retired_event_ids VALUES(p_calendar,p_remote);
   IF m.is_master THEN
     INSERT INTO public.google_retired_event_ids(calendar_id,remote_id)
      SELECT child.calendar_id,child.remote_id FROM public.google_managed_events child JOIN public.google_series_occurrences o USING(event_id)
       WHERE child.calendar_id=p_calendar AND o.household_id=c.household_id AND o.series_id=family.series_id AND child.remote_bound ON CONFLICT DO NOTHING;
     UPDATE public.google_managed_events child SET remote_id='irori'||replace(child.event_id::text,'-',''),remote_bound=false,
      common=NULL,common_version=NULL,etag=NULL,intent=NULL,pending=true,choice=NULL,conflict_id=NULL,observed=NULL
      FROM public.google_series_occurrences o WHERE child.event_id=o.event_id AND child.calendar_id=p_calendar
       AND o.household_id=c.household_id AND o.series_id=family.series_id;
   END IF;
   UPDATE public.google_managed_events SET remote_id='r'||replace(gen_random_uuid()::text,'-',''),common=NULL,etag=NULL,intent=NULL,
     legacy_unverified=false,pending=true,choice=NULL,observed=NULL,conflict_id=NULL WHERE calendar_id=p_calendar AND event_id=m.event_id;
   RETURN jsonb_build_object('action','none');
 END IF;
 IF p_state='cancelled' AND merged<>'null' THEN merged:=NULL; END IF;
 IF merged IS NULL OR (NOT has_event AND merged<>'null' AND EXISTS(
   SELECT 1 FROM public.google_event_deletions WHERE household_id=c.household_id AND event_id=m.event_id) AND NOT reversible) THEN
   UPDATE public.google_managed_events SET conflict_id=CASE WHEN conflict_id IS NOT NULL AND conflict_version IS NOT DISTINCT FROM e.updated_at
     AND conflict_etag IS NOT DISTINCT FROM p_etag AND observed=remote_doc THEN conflict_id ELSE gen_random_uuid() END,
     observed=remote_doc,protected=(p_state='protected'),conflict_etag=p_etag,conflict_version=e.updated_at,choice=NULL,pending=false,intent=NULL WHERE calendar_id=p_calendar AND event_id=m.event_id;
   RETURN jsonb_build_object('action','conflict');
 END IF;
 IF merged IS DISTINCT FROM local_doc THEN
   IF m.is_master THEN
     UPDATE public.google_family_series SET retired_doc=CASE WHEN merged='null' THEN doc ELSE NULL END,doc=merged,version=clock_timestamp() WHERE root_id=m.event_id RETURNING version INTO e.updated_at;
     IF merged='null' THEN
       UPDATE public.google_managed_events child SET pending=true FROM public.google_series_occurrences o
        WHERE child.calendar_id=p_calendar AND child.event_id=o.event_id AND o.household_id=c.household_id AND o.series_id=family.series_id;
     END IF;
   ELSIF merged='null' THEN
     DELETE FROM public.calendar_events WHERE id=m.event_id AND household_id=c.household_id;
     DELETE FROM public.event_reminders WHERE household_id=c.household_id AND event_uid=m.event_id::text;
     DELETE FROM public.event_purposes WHERE household_id=c.household_id AND (
       (scope='event' AND target_key=m.event_id::text) OR (scope='series' AND target_key=e.series_id::text AND NOT EXISTS(
        SELECT 1 FROM public.calendar_events WHERE household_id=c.household_id AND series_id=e.series_id)));
   ELSE
     timing:=merged->'timing'; is_day:=timing ? 'start';
     IF is_day THEN start_day:=(timing->>'start')::date; end_day:=(timing->>'end')::date;
     ELSE start_at_value:=(timing->>'startAt')::timestamptz; end_at_value:=(timing->>'endAt')::timestamptz;
       start_day:=(start_at_value AT TIME ZONE 'Asia/Tokyo')::date; end_day:=(end_at_value AT TIME ZONE 'Asia/Tokyo')::date;
     END IF;
     IF has_event THEN
       UPDATE public.calendar_events SET title=merged->>'title',is_all_day=is_day,start_date=start_day,end_date=end_day,
         start_at=start_at_value,end_at=end_at_value WHERE id=e.id RETURNING * INTO e;
     ELSE
       IF reversible THEN DELETE FROM public.google_event_deletions WHERE household_id=c.household_id AND event_id=m.event_id; END IF;
       INSERT INTO public.calendar_events(id,household_id,title,is_all_day,start_date,end_date,start_at,end_at,source,created_by,series_id)
       VALUES(m.event_id,c.household_id,merged->>'title',is_day,start_day,end_day,start_at_value,end_at_value,'native',c.user_id,CASE WHEN retired_instance AND reversible THEN NULL ELSE p_series END) RETURNING * INTO e;
     END IF;
   END IF;
 END IF;
 IF m.is_master AND merged IS DISTINCT FROM remote_doc AND merged<>'null'::jsonb AND NOT EXISTS(
   SELECT 1 FROM public.calendar_events member WHERE member.household_id=c.household_id AND member.series_id=family.series_id
   AND member.end_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date-90 AND member.start_date <= (now() AT TIME ZONE 'Asia/Tokyo')::date+365
   AND member.child_id IS NULL AND member.medical_record_id IS NULL AND member.source='native') THEN
   UPDATE public.google_managed_events SET pending=false WHERE calendar_id=p_calendar AND event_id=m.event_id;
   RETURN jsonb_build_object('action','none');
 END IF;
 IF NOT m.is_master AND merged<>remote_doc AND has_event AND (e.end_date < (now() AT TIME ZONE 'Asia/Tokyo')::date-90 OR e.start_date > (now() AT TIME ZONE 'Asia/Tokyo')::date+365) THEN
   UPDATE public.google_managed_events SET pending=false WHERE calendar_id=p_calendar AND event_id=m.event_id;
   RETURN jsonb_build_object('action','none');
 END IF;
 IF p_anchor IS NOT NULL AND p_state='cancelled' AND merged='null' THEN
   INSERT INTO public.google_event_deletions VALUES(c.household_id,m.event_id) ON CONFLICT DO NOTHING;
   INSERT INTO public.google_managed_events(calendar_id,event_id,remote_id)
   SELECT dest.calendar_id,m.event_id,'irori'||replace(m.event_id::text,'-','')
   FROM public.google_managed_calendars dest WHERE dest.household_id=c.household_id AND dest.calendar_id<>p_calendar
   ON CONFLICT(calendar_id,event_id) DO NOTHING;
 END IF;
 IF merged=remote_doc THEN
   UPDATE public.google_managed_events SET legacy_unverified=false,common=merged,common_version=e.updated_at,etag=p_etag,pending=false,intent=NULL,observed=NULL,
     conflict_id=NULL,choice=NULL,retired_master=false WHERE calendar_id=p_calendar AND event_id=m.event_id;
   RETURN jsonb_build_object('action','none');
 END IF;
 UPDATE public.google_managed_events SET common=m.common,intent=merged,pending=true,queued_at=clock_timestamp(),conflict_id=NULL,choice=NULL
   WHERE calendar_id=p_calendar AND event_id=m.event_id;
 RETURN jsonb_build_object('action',CASE WHEN merged='null' THEN 'delete' WHEN p_state='missing' THEN 'insert' ELSE 'patch' END,'doc',merged);
END;
$$;
REVOKE ALL ON FUNCTION public.google_managed_exchange(text,timestamptz,text,text,jsonb,text,uuid,uuid,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.google_managed_exchange(text,timestamptz,text,text,jsonb,text,uuid,uuid,boolean,text) TO service_role;

ALTER TABLE public.google_calendar_exports ADD COLUMN bidirectional boolean NOT NULL DEFAULT false;
ALTER TABLE public.google_calendar_exports ADD COLUMN worker_nonce uuid;
CREATE FUNCTION irori_private.guard_google_worker_protocol() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.bidirectional AND NEW.lease_until IS NOT NULL AND NEW.lease_until IS DISTINCT FROM OLD.lease_until
     AND (NEW.worker_nonce IS NULL OR NEW.worker_nonce IS NOT DISTINCT FROM OLD.worker_nonce) THEN
    RAISE EXCEPTION 'managed calendar requires current worker' USING ERRCODE='55P03';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER google_worker_protocol BEFORE UPDATE ON public.google_calendar_exports FOR EACH ROW EXECUTE FUNCTION irori_private.guard_google_worker_protocol();

CREATE TABLE public.google_managed_inbox (
 calendar_id text NOT NULL REFERENCES public.google_managed_calendars ON DELETE CASCADE,
 remote_id text NOT NULL, cancelled boolean NOT NULL, queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(calendar_id,remote_id)
);
ALTER TABLE public.google_managed_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_managed_inbox FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.google_managed_inbox TO service_role;
-- Accumulate observed identities across every page of a full scan.
CREATE TABLE public.google_scan_seen(
 calendar_id text NOT NULL REFERENCES public.google_managed_calendars ON DELETE CASCADE,
 remote_id text NOT NULL, PRIMARY KEY(calendar_id,remote_id)
);
ALTER TABLE public.google_scan_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_scan_seen FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.google_scan_seen TO service_role;
CREATE FUNCTION public.google_managed_cursor(p_calendar text,p_lease timestamptz,p_sync text,p_page text,p_start date,p_end date,p_scanned date,p_items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.google_managed_calendars; full_scan boolean;
BEGIN
 target:=irori_private.require_google_lease(p_calendar,p_lease);
 full_scan:=target.sync_token IS NULL OR target.window_start IS DISTINCT FROM p_start OR (target.page_token IS NULL AND target.scanned_on IS DISTINCT FROM p_scanned AND p_page IS NULL);
 IF full_scan AND target.page_token IS NULL THEN DELETE FROM public.google_scan_seen WHERE calendar_id=p_calendar; END IF;
 INSERT INTO public.google_managed_inbox(calendar_id,remote_id,cancelled)
 SELECT DISTINCT p_calendar,t.parent,false FROM jsonb_to_recordset(p_items) AS t(parent text) WHERE t.parent IS NOT NULL
 AND (NOT full_scan OR NOT EXISTS(SELECT 1 FROM public.google_scan_seen seen WHERE seen.calendar_id=p_calendar AND seen.remote_id=t.parent))
 ON CONFLICT DO NOTHING;
 IF full_scan THEN
   INSERT INTO public.google_scan_seen SELECT p_calendar,observed FROM jsonb_to_recordset(p_items) AS t(id text,parent text)
    CROSS JOIN LATERAL unnest(ARRAY[t.id,t.parent]) observed WHERE observed IS NOT NULL ON CONFLICT DO NOTHING;
 END IF;
 IF EXISTS (SELECT 1 FROM public.google_managed_calendars WHERE calendar_id=p_calendar AND window_start IS DISTINCT FROM p_start) THEN
   INSERT INTO public.google_managed_events(calendar_id,event_id,remote_id)
   SELECT c.calendar_id,e.id,'irori'||replace(e.id::text,'-','') FROM public.google_managed_calendars c
   JOIN public.calendar_events e ON e.household_id=c.household_id
   WHERE c.calendar_id=p_calendar AND e.source='native' AND e.child_id IS NULL AND e.medical_record_id IS NULL AND e.end_date>=p_start AND e.start_date<p_end
   ON CONFLICT(calendar_id,event_id) DO UPDATE SET pending=true WHERE google_managed_events.common IS NULL AND google_managed_events.conflict_id IS NULL;
   UPDATE public.google_managed_events m SET pending=true FROM public.google_family_series s
    WHERE m.calendar_id=p_calendar AND m.event_id=s.root_id AND m.common IS NULL AND m.conflict_id IS NULL AND EXISTS(
     SELECT 1 FROM public.calendar_events e WHERE e.household_id=s.household_id AND e.series_id=s.series_id
     AND e.source='native' AND e.child_id IS NULL AND e.medical_record_id IS NULL AND e.end_date>=p_start AND e.start_date<p_end);
 END IF;
 INSERT INTO public.google_managed_inbox(calendar_id,remote_id,cancelled)
 SELECT p_calendar,t.id,t.cancelled FROM pg_catalog.jsonb_to_recordset(p_items) AS t(id text,cancelled boolean,etag text)
 WHERE t.etag IS NULL OR NOT EXISTS(SELECT 1 FROM public.google_managed_events m WHERE m.calendar_id=p_calendar AND m.remote_id=t.id AND m.etag=t.etag
   AND m.common IS NOT NULL AND (m.common='null')=t.cancelled AND NOT m.pending)
 ON CONFLICT(calendar_id,remote_id) DO UPDATE SET cancelled=excluded.cancelled,queued_at=clock_timestamp();
 -- Revalidate existing identities individually after a complete full scan.
 -- Absence from a page (including a changed window) never proves deletion.
 IF p_scanned IS NOT NULL AND p_page IS NULL AND EXISTS (SELECT 1 FROM public.google_managed_calendars
   WHERE calendar_id=p_calendar AND scanned_on IS DISTINCT FROM p_scanned) THEN
   INSERT INTO public.google_managed_inbox(calendar_id,remote_id,cancelled)
   SELECT calendar_id,remote_id,false FROM public.google_managed_events m WHERE m.calendar_id=p_calendar AND m.common IS NOT NULL AND m.common<>'null'
   AND NOT EXISTS(SELECT 1 FROM public.google_scan_seen seen WHERE seen.calendar_id=m.calendar_id AND seen.remote_id=m.remote_id)
   AND (m.is_master OR ((coalesce(m.common#>>'{timing,end}',m.common#>>'{timing,endAt}'))::timestamptz AT TIME ZONE 'Asia/Tokyo')::date>=p_start
   AND ((coalesce(m.common#>>'{timing,start}',m.common#>>'{timing,startAt}'))::timestamptz AT TIME ZONE 'Asia/Tokyo')::date<p_end)
   ON CONFLICT DO NOTHING;
   DELETE FROM public.google_scan_seen WHERE calendar_id=p_calendar;
 END IF;
 UPDATE public.google_managed_calendars SET sync_token=p_sync,page_token=p_page,window_start=p_start,window_end=p_end,scanned_on=p_scanned WHERE calendar_id=p_calendar;
END;
$$;
REVOKE ALL ON FUNCTION public.google_managed_cursor(text,timestamptz,text,text,date,date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.google_managed_cursor(text,timestamptz,text,text,date,date,date,jsonb) TO service_role;

CREATE FUNCTION public.google_managed_status(p_connection uuid,p_user uuid,p_household uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH owned AS (
  SELECT x.calendar_id FROM public.google_calendar_exports x JOIN public.google_connections g ON g.id=x.connection_id AND g.household_id=x.household_id
  JOIN public.profiles p ON p.id=g.user_id AND p.household_id=g.household_id AND p.is_approved AND p.role<>'viewer'
  WHERE g.id=p_connection AND g.user_id=p_user AND g.household_id=p_household AND x.bidirectional
 ), conflicts AS (
  SELECT m.conflict_id id,CASE WHEN m.is_master THEN s.doc ELSE irori_private.google_event_doc(e) END AS local,m.observed AS google,m.protected
  FROM public.google_managed_events m JOIN owned USING(calendar_id)
  LEFT JOIN public.calendar_events e ON e.id=m.event_id AND e.household_id=p_household
  LEFT JOIN public.google_family_series s ON m.is_master AND s.root_id=m.event_id AND s.household_id=p_household
  WHERE m.conflict_id IS NOT NULL ORDER BY m.queued_at,m.event_id LIMIT 25
 )
 SELECT jsonb_build_object('pending',EXISTS(SELECT 1 FROM public.google_managed_events m JOIN owned USING(calendar_id) WHERE pending) OR EXISTS(SELECT 1 FROM public.google_managed_inbox JOIN owned USING(calendar_id)),
 'conflicts',coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM conflicts c),'[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.google_managed_status(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.google_managed_status(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.google_managed_choose(p_connection uuid,p_user uuid,p_household uuid,p_conflict uuid,p_choice text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_choice NOT IN ('local','google') OR p_choice IS NULL THEN RETURN false; END IF;
 UPDATE public.google_managed_events m SET choice=p_choice,pending=true,queued_at=clock_timestamp()
 FROM public.google_calendar_exports x JOIN public.google_connections g ON g.id=x.connection_id AND g.household_id=x.household_id
 JOIN public.profiles p ON p.id=g.user_id AND p.household_id=g.household_id AND p.is_approved AND p.role<>'viewer'
 WHERE x.calendar_id=m.calendar_id AND x.enabled AND x.bidirectional AND g.id=p_connection AND g.user_id=p_user AND g.household_id=p_household
 AND m.conflict_id=p_conflict AND NOT m.protected AND m.choice IS NULL
;
 RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.google_managed_choose(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.google_managed_choose(uuid,uuid,uuid,uuid,text) TO service_role;

CREATE TABLE public.google_calendar_provisioning (
 household_id uuid NOT NULL REFERENCES public.households ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles ON DELETE CASCADE,
 google_account_id text NOT NULL,
 marker uuid NOT NULL UNIQUE,
 attempted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(household_id,user_id,google_account_id)
);
ALTER TABLE public.google_calendar_provisioning ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_calendar_provisioning FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.google_calendar_provisioning TO service_role;
INSERT INTO public.google_calendar_provisioning(household_id,user_id,google_account_id,marker,attempted)
 SELECT g.household_id,g.user_id,g.google_account_id,g.id,x.provisioning OR x.calendar_id IS NOT NULL
 FROM public.google_connections g JOIN public.google_calendar_exports x ON g.id=x.connection_id AND g.household_id=x.household_id;
REVOKE ALL ON FUNCTION irori_private.require_google_lease(text,timestamptz),irori_private.google_event_doc(public.calendar_events),
 irori_private.google_merge(jsonb,jsonb,jsonb),irori_private.guard_google_worker_protocol() FROM PUBLIC,anon,authenticated;

-- Resolve the series owner from the account-bound remote master. All methods
-- operate under the same lease as ordinary event writes.
CREATE FUNCTION public.google_managed_series_context(p_calendar text,p_lease timestamptz,p_remote text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.google_managed_calendars; info jsonb;
BEGIN
 c:=irori_private.require_google_lease(p_calendar,p_lease);
 SELECT jsonb_build_object('kind','master','series',s.series_id,'retired',s.doc='null' AND m.conflict_id IS NULL,'active',s.doc<>'null' AND NOT m.protected AND m.conflict_id IS NULL) INTO info FROM public.google_managed_events m
 JOIN public.google_family_series s ON s.root_id=m.event_id AND s.household_id=c.household_id
 WHERE m.calendar_id=p_calendar AND m.remote_id=p_remote AND m.is_master;
 IF info IS NOT NULL THEN RETURN info; END IF;
 SELECT jsonb_build_object('kind','instance','series',i.series_id,'anchor',i.anchor,'master',root.remote_id,'eventId',i.event_id,
 'bound',m.remote_bound,'parentCancelled',s.doc='null' AND root.common='null' AND root.conflict_id IS NULL,'rootReady',root.common IS NOT NULL AND root.common<>'null' AND root.conflict_id IS NULL) INTO info
 FROM public.google_managed_events m JOIN public.google_series_occurrences i ON i.event_id=m.event_id AND i.household_id=c.household_id
 JOIN public.google_family_series s ON s.series_id=i.series_id AND s.household_id=i.household_id
 JOIN public.google_managed_events root ON root.calendar_id=m.calendar_id AND root.event_id=s.root_id AND root.is_master
 WHERE m.calendar_id=p_calendar AND m.remote_id=p_remote;
 RETURN coalesce(info,'{}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.google_managed_series_context(text,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.google_managed_series_context(text,timestamptz,text) TO service_role;

-- The sheet captures this snapshot once. A new, edited or removed member invalidates it.
CREATE FUNCTION public.calendar_series_revision(p_series uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT md5(jsonb_build_array(s.version,
   (SELECT jsonb_agg(jsonb_build_array(e.id,e.updated_at) ORDER BY e.id)
    FROM public.calendar_events e WHERE e.household_id=p.household_id AND e.series_id=p_series AND e.source='native'))::text)
 FROM public.profiles p LEFT JOIN public.google_family_series s ON s.series_id=p_series AND s.household_id=p.household_id
 WHERE p.id=auth.uid() AND p.is_approved AND p.role IN ('owner','member')
 AND EXISTS(SELECT 1 FROM public.calendar_events e WHERE e.household_id=p.household_id AND e.series_id=p_series AND e.source='native')
$$;
REVOKE ALL ON FUNCTION public.calendar_series_revision(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_series_revision(uuid) TO authenticated;

CREATE FUNCTION public.delete_managed_calendar_series(p_series uuid,p_anchor uuid,p_version timestamptz,p_revision text)
RETURNS TABLE(id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h uuid;
BEGIN
 SELECT household_id INTO h FROM public.profiles WHERE profiles.id=auth.uid() AND is_approved AND role IN ('owner','member');
 IF h IS NULL THEN RAISE EXCEPTION 'not a household editor' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(h::text||p_series::text,0));
 PERFORM 1 FROM public.google_family_series WHERE household_id=h AND series_id=p_series FOR UPDATE;
 PERFORM 1 FROM public.calendar_events e WHERE e.household_id=h AND e.series_id=p_series ORDER BY e.id FOR UPDATE;
 IF p_revision IS NULL OR public.calendar_series_revision(p_series) IS DISTINCT FROM p_revision THEN
   RAISE EXCEPTION 'series changed' USING ERRCODE='40001';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.calendar_events e WHERE e.household_id=h AND e.series_id=p_series AND e.source='native' AND e.id=p_anchor AND e.updated_at=p_version)
    OR EXISTS(SELECT 1 FROM public.calendar_events e WHERE e.household_id=h AND e.series_id=p_series AND e.medical_record_id IS NOT NULL) THEN
   RAISE EXCEPTION 'series changed' USING ERRCODE='40001';
 END IF;
 UPDATE public.google_family_series SET retired_doc=doc,doc='null',version=clock_timestamp() WHERE household_id=h AND series_id=p_series;
 RETURN QUERY DELETE FROM public.calendar_events e WHERE e.household_id=h AND e.series_id=p_series AND e.source='native' RETURNING e.id;
END;
$$;
REVOKE ALL ON FUNCTION public.delete_managed_calendar_series(uuid,uuid,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.delete_managed_calendar_series(uuid,uuid,timestamptz,text) TO authenticated;

CREATE FUNCTION public.google_managed_sync_ready() RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT public.google_sharing_schema_ready() AND to_regclass('public.google_managed_inbox') IS NOT NULL
   AND to_regprocedure('public.google_managed_series_context(text,timestamptz,text)') IS NOT NULL
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.calendar_events'::regclass AND tgname='queue_google_event' AND tgenabled='O')
$$;
REVOKE ALL ON FUNCTION public.google_managed_sync_ready() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.google_managed_sync_ready() TO authenticated,service_role;
