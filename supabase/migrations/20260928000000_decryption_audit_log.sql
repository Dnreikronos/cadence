-- Run as the migration administrator, never as service_role.
CREATE TABLE public.decryption_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor text NOT NULL CHECK (actor ~ '[^[:space:]]'),
    reason text NOT NULL CHECK (reason ~ '[^[:space:]]'),
    target_account text NOT NULL CHECK (target_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.decryption_audit_log ENABLE ROW LEVEL SECURITY;

-- RLS does not constrain Supabase's BYPASSRLS service role; privileges do.
REVOKE ALL ON public.decryption_audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT (actor, reason, target_account)
    ON public.decryption_audit_log TO service_role;

COMMENT ON TABLE public.decryption_audit_log IS
    'Append-only for service_role. Trusted administrators retain control. Never store amounts or secrets in attribution fields.';
