-- Idempotency stores metadata and ciphertext only, never amounts or key material.
ALTER TABLE public.runs ADD COLUMN idempotency_key uuid CHECK (idempotency_key IS NULL OR idempotency_key<>'00000000-0000-0000-0000-000000000000');
CREATE UNIQUE INDEX runs_owner_idempotency ON public.runs (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
GRANT INSERT (idempotency_key) ON public.runs TO cadence_transfer_service;

-- Supabase identity is verified by the service before this role is used.
GRANT SELECT ON public.memberships TO cadence_transfer_service;
CREATE POLICY memberships_proof_read ON public.memberships FOR SELECT
    TO cadence_transfer_service USING (true);
DROP POLICY runs_service ON public.runs;
CREATE POLICY runs_service ON public.runs TO cadence_transfer_service USING (true)
    WITH CHECK (EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id=runs.user_id AND m.role='admin'));
