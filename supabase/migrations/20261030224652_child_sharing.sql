-- Restricted sharing is independent of household participation and operator approval.
ALTER TABLE public.invitations ADD COLUMN purpose text NOT NULL DEFAULT 'member'
 CHECK (purpose IN ('member','child_share'));
CREATE TABLE public.child_shares (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
 child_id uuid NOT NULL,
 invitation_id uuid NOT NULL UNIQUE REFERENCES public.invitations(id),
 viewer_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
 allow_daily boolean NOT NULL DEFAULT true,
 allow_diary boolean NOT NULL DEFAULT false,
 allow_health boolean NOT NULL DEFAULT false,
 allow_custom boolean NOT NULL DEFAULT false,
 expires_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(household_id,child_id) REFERENCES public.children(household_id,id),
 CHECK (allow_daily OR allow_diary OR allow_health OR allow_custom),
 CHECK (expires_at IS NULL OR (isfinite(expires_at) AND expires_at > created_at))
);
ALTER TABLE public.child_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.child_shares FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.child_shares TO service_role;
CREATE INDEX child_shares_viewer ON public.child_shares(viewer_id) WHERE revoked_at IS NULL;
CREATE INDEX child_shares_household ON public.child_shares(household_id);

CREATE OR REPLACE FUNCTION public.get_my_household_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT household_id FROM public.profiles WHERE id=(SELECT auth.uid()) AND is_approved AND role <> 'viewer';
$$;
REVOKE ALL ON FUNCTION public.get_my_household_id() FROM PUBLIC,anon;
-- Existing anon RLS predicates call this helper; an unauthenticated caller always receives NULL.
GRANT EXECUTE ON FUNCTION public.get_my_household_id() TO anon,authenticated,service_role;
CREATE FUNCTION irori_private.is_household_owner(h uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=(SELECT auth.uid()) AND p.household_id=h AND p.is_approved AND p.role='owner');
$$;
REVOKE ALL ON FUNCTION irori_private.is_household_owner(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION irori_private.is_household_owner(uuid) TO authenticated;

-- Ordinary clients cannot mutate a restricted invitation into a membership invitation.
DROP POLICY invitations_select ON public.invitations;
CREATE POLICY invitations_select ON public.invitations FOR SELECT TO authenticated USING (
 household_id=(SELECT public.get_my_household_id()) AND (purpose='member' OR irori_private.is_household_owner(household_id)));
DROP POLICY invitations_insert ON public.invitations;
CREATE POLICY invitations_insert ON public.invitations FOR INSERT TO authenticated WITH CHECK (
 household_id=(SELECT public.get_my_household_id()) AND purpose='member' AND role='member' AND invited_by=(SELECT auth.uid()));
DROP POLICY invitations_update ON public.invitations;
CREATE POLICY invitations_update ON public.invitations FOR UPDATE TO authenticated USING (
 household_id=(SELECT public.get_my_household_id()) AND purpose='member') WITH CHECK (
 household_id=(SELECT public.get_my_household_id()) AND purpose='member' AND role='member');
DROP POLICY IF EXISTS invitations_delete ON public.invitations;
CREATE POLICY invitations_delete ON public.invitations FOR DELETE TO authenticated USING (
 household_id=(SELECT public.get_my_household_id()) AND purpose='member');

CREATE OR REPLACE FUNCTION public.accept_invitation(invitation_uuid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE inv public.invitations; actor uuid := auth.uid();
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.profiles WHERE id=actor FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.profiles WHERE id=actor AND household_id IS NOT NULL) THEN RAISE EXCEPTION 'User already belongs to a household'; END IF;
 SELECT * INTO inv FROM public.invitations WHERE id=invitation_uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found'; END IF;
 IF inv.purpose <> 'member' OR inv.role <> 'member' THEN RAISE EXCEPTION 'Use the restricted sharing invitation' USING ERRCODE='42501'; END IF;
 IF inv.status <> 'pending' THEN RAISE EXCEPTION 'Invitation is not pending'; END IF;
 IF inv.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'Invitation has expired'; END IF;
 UPDATE public.profiles SET household_id=inv.household_id,role=inv.role,is_approved=true WHERE id=actor;
 UPDATE public.invitations SET status='accepted',accepted_by=actor WHERE id=inv.id;
END;
$$;
REVOKE ALL ON FUNCTION public.accept_invitation(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(uuid) TO authenticated;

CREATE FUNCTION public.create_child_share(p_child_id uuid,p_daily boolean,p_diary boolean,p_health boolean,p_custom boolean,p_until timestamptz DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.children; inv public.invitations; share_id uuid;
BEGIN
 SELECT * INTO c FROM public.children WHERE id=p_child_id;
 IF NOT FOUND OR NOT irori_private.is_household_owner(c.household_id) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
 IF NOT coalesce(p_daily OR p_diary OR p_health OR p_custom,false) OR p_daily IS NULL OR p_diary IS NULL OR p_health IS NULL OR p_custom IS NULL
  OR (p_until IS NOT NULL AND (NOT isfinite(p_until) OR p_until <= clock_timestamp())) THEN RAISE EXCEPTION 'invalid sharing scope' USING ERRCODE='22023'; END IF;
 INSERT INTO public.invitations(household_id,invited_by,role,purpose,expires_at)
 VALUES(c.household_id,auth.uid(),'viewer','child_share',least(clock_timestamp()+interval '7 days',coalesce(p_until,'infinity'::timestamptz))) RETURNING * INTO inv;
 INSERT INTO public.child_shares(household_id,child_id,invitation_id,allow_daily,allow_diary,allow_health,allow_custom,expires_at)
 VALUES(c.household_id,c.id,inv.id,p_daily,p_diary,p_health,p_custom,p_until) RETURNING id INTO share_id;
 RETURN jsonb_build_object('id',share_id,'token',inv.token,'invite_expires_at',inv.expires_at,'expires_at',p_until);
END;
$$;
CREATE FUNCTION irori_private.is_household_owner_for_user(h uuid,u uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=u AND household_id=h AND is_approved AND role='owner');
$$;
REVOKE ALL ON FUNCTION irori_private.is_household_owner_for_user(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.accept_child_share(p_token text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE inv public.invitations; s public.child_shares; actor uuid := auth.uid();
BEGIN
 IF actor IS NULL OR p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.profiles WHERE id=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
 SELECT * INTO inv FROM public.invitations WHERE token=p_token AND purpose='child_share' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.child_shares WHERE invitation_id=inv.id FOR UPDATE;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR (s.expires_at IS NOT NULL AND s.expires_at <= clock_timestamp())
  OR inv.expires_at <= clock_timestamp() OR NOT irori_private.is_household_owner_for_user(inv.household_id,inv.invited_by)
 THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE='42501'; END IF;
 IF inv.status='accepted' AND inv.accepted_by=actor AND s.viewer_id=actor THEN RETURN s.id; END IF;
 IF inv.status <> 'pending' OR s.viewer_id IS NOT NULL THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE='42501'; END IF;
 UPDATE public.invitations SET status='accepted',accepted_by=actor WHERE id=inv.id;
 UPDATE public.child_shares SET viewer_id=actor WHERE id=s.id;
 -- No household membership is granted. Existing members retain their original household and role.
 UPDATE public.profiles SET is_approved=true,role=CASE WHEN household_id IS NULL THEN 'viewer'::public.household_role ELSE role END WHERE id=actor;
 RETURN s.id;
END;
$$;
CREATE FUNCTION public.revoke_child_share(p_share_id uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.child_shares;
BEGIN
 SELECT * INTO s FROM public.child_shares WHERE id=p_share_id;
 IF NOT FOUND OR NOT irori_private.is_household_owner(s.household_id) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.invitations WHERE id=s.invitation_id FOR UPDATE;
 UPDATE public.child_shares SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=s.id;
 UPDATE public.invitations SET status='expired' WHERE id=s.invitation_id;
 RETURN true;
END;
$$;
CREATE FUNCTION public.list_child_shares(p_owned boolean DEFAULT false) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'child_name',c.name,'allow_daily',s.allow_daily,
  'allow_diary',s.allow_diary,'allow_health',s.allow_health,'allow_custom',s.allow_custom,
  'expires_at',s.expires_at,'revoked_at',s.revoked_at,'accepted',s.viewer_id IS NOT NULL,
  'viewer_name',CASE WHEN p_owned THEN p.display_name ELSE NULL END) ORDER BY s.created_at DESC),'[]'::jsonb)
 FROM public.child_shares s JOIN public.children c ON c.id=s.child_id
 JOIN public.invitations i ON i.id=s.invitation_id LEFT JOIN public.profiles p ON p.id=s.viewer_id
 WHERE (p_owned AND irori_private.is_household_owner(s.household_id)) OR
  (NOT p_owned AND s.viewer_id=(SELECT auth.uid()) AND s.revoked_at IS NULL
   AND (s.expires_at IS NULL OR s.expires_at > now())
   AND irori_private.is_household_owner_for_user(s.household_id,i.invited_by)
   AND EXISTS(SELECT 1 FROM public.profiles v WHERE v.id=(SELECT auth.uid()) AND v.is_approved));
$$;
CREATE FUNCTION public.shared_child_snapshot(p_share_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.child_shares; c public.children; daily jsonb; health jsonb; diary jsonb; valid_ms integer;
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
 valid_ms := least(15000,coalesce(greatest(0,floor(extract(epoch FROM (s.expires_at-clock_timestamp()))*1000)),15000))::integer;
 RETURN jsonb_build_object('child_name',c.name,'birth_date',CASE WHEN s.allow_health THEN c.birth_date ELSE NULL END,
  'daily',daily,'health',health,'diary',diary,'allow_daily',s.allow_daily,'allow_diary',s.allow_diary,
  'allow_health',s.allow_health,'allow_custom',s.allow_custom,'expires_at',s.expires_at,'valid_for_ms',valid_ms,
  'window_note','日常7日・健康30日・日記8日。件数上限のある閲覧です');
END;
$$;
REVOKE ALL ON FUNCTION public.create_child_share(uuid,boolean,boolean,boolean,boolean,timestamptz) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.accept_child_share(text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.revoke_child_share(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.list_child_shares(boolean) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.shared_child_snapshot(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_child_share(uuid,boolean,boolean,boolean,boolean,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_child_share(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_child_share(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_child_shares(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shared_child_snapshot(uuid) TO authenticated;
