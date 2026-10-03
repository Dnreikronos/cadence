-- Verified user attribution and public ciphertext only; no amount or secret.
CREATE ROLE cadence_transfer_service NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO cadence_transfer_service;

CREATE TABLE public.proof_wallets (
    wallet text PRIMARY KEY CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (wallet, user_id)
);
ALTER TABLE public.proof_wallets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.proof_wallets FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT (wallet, user_id) ON public.proof_wallets TO cadence_transfer_service;
CREATE POLICY transfer_wallet_read ON public.proof_wallets FOR SELECT
    TO cadence_transfer_service USING (true);
CREATE POLICY transfer_wallet_link ON public.proof_wallets FOR INSERT
    TO cadence_transfer_service WITH CHECK (true);
