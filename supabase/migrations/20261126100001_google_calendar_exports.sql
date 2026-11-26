-- Explicit, per-account opt-in. No token, lease or export setting is browser-readable.
CREATE TABLE public.google_calendar_exports (
  connection_id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  calendar_id text UNIQUE CHECK (calendar_id IS NULL OR char_length(btrim(calendar_id)) BETWEEN 1 AND 1024),
  provisioning boolean NOT NULL DEFAULT false,
  lease_until timestamptz,
  last_synced_at timestamptz,
  last_error text CHECK (last_error IN ('partial','permission','provisioning','unavailable','limit','failed')),
  FOREIGN KEY (connection_id, household_id)
    REFERENCES public.google_connections(id, household_id) ON DELETE CASCADE,
  CHECK (NOT enabled OR calendar_id IS NOT NULL)
);
ALTER TABLE public.google_calendar_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_calendar_exports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.google_calendar_exports TO service_role;
COMMENT ON TABLE public.google_calendar_exports IS 'Per-connection opt-in to export ordinary household events to an app-created Google calendar. Service role only; no realtime.';
