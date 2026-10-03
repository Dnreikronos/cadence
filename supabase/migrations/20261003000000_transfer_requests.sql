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

CREATE TABLE public.transfer_requests (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    company_wallet text NOT NULL,
    sender text NOT NULL CHECK (sender ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    destination text NOT NULL CHECK (destination ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    transaction text NOT NULL CHECK (length(transaction) BETWEEN 1 AND 5464),
    last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height >= 0),
    signature text UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    slot bigint CHECK (slot >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (company_wallet, user_id) REFERENCES public.proof_wallets(wallet, user_id),
    CHECK ((signature IS NULL) = (slot IS NULL))
);
ALTER TABLE public.transfer_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transfer_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.transfer_requests TO cadence_transfer_service;
GRANT INSERT (id, user_id, company_wallet, sender, destination, transaction, last_valid_block_height)
    ON public.transfer_requests TO cadence_transfer_service;
GRANT UPDATE (signature, slot) ON public.transfer_requests TO cadence_transfer_service;
CREATE POLICY transfer_read ON public.transfer_requests FOR SELECT
    TO cadence_transfer_service USING (true);
CREATE POLICY transfer_prepare ON public.transfer_requests FOR INSERT
    TO cadence_transfer_service WITH CHECK (signature IS NULL AND slot IS NULL);
CREATE POLICY transfer_confirm ON public.transfer_requests FOR UPDATE
    TO cadence_transfer_service USING (true) WITH CHECK (signature IS NOT NULL AND slot IS NOT NULL);

CREATE FUNCTION public.guard_transfer_confirmation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF OLD.signature IS NOT NULL AND
       (NEW.signature IS DISTINCT FROM OLD.signature OR NEW.slot IS DISTINCT FROM OLD.slot) THEN
        RAISE EXCEPTION 'transfer confirmation is immutable';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_transfer_confirmation() FROM PUBLIC;
CREATE TRIGGER immutable_transfer_confirmation BEFORE UPDATE ON public.transfer_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_transfer_confirmation();
