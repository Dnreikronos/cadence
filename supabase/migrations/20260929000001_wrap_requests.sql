-- Public chain data only. No derivation signature, AES key or viewing secret.
CREATE ROLE cadence_wrap_service NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT cadence_wrap_service TO authenticator;
GRANT USAGE ON SCHEMA public TO cadence_wrap_service;

CREATE TABLE public.wrap_requests (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    company_wallet text NOT NULL CHECK (company_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    destination text NOT NULL CHECK (destination ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    transaction text NOT NULL CHECK (length(transaction) BETWEEN 1 AND 5464),
    last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height >= 0),
    signature text UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    slot bigint CHECK (slot >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((signature IS NULL) = (slot IS NULL))
);

ALTER TABLE public.wrap_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wrap_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.wrap_requests TO cadence_wrap_service;
GRANT INSERT (id, company_wallet, destination, transaction, last_valid_block_height, signature, slot)
    ON public.wrap_requests TO cadence_wrap_service;
GRANT UPDATE (signature, slot) ON public.wrap_requests TO cadence_wrap_service;
CREATE POLICY wrap_service_read ON public.wrap_requests FOR SELECT
    TO cadence_wrap_service USING (true);
CREATE POLICY wrap_service_prepare ON public.wrap_requests FOR INSERT
    TO cadence_wrap_service WITH CHECK (signature IS NULL AND slot IS NULL);
CREATE POLICY wrap_service_confirm ON public.wrap_requests FOR UPDATE
    TO cadence_wrap_service USING (true) WITH CHECK (signature IS NOT NULL AND slot IS NOT NULL);

-- Even a service retry cannot replace a receipt or change its prepared message.
CREATE FUNCTION public.guard_wrap_confirmation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF OLD.signature IS NOT NULL AND
       (NEW.signature IS DISTINCT FROM OLD.signature OR NEW.slot IS DISTINCT FROM OLD.slot) THEN
        RAISE EXCEPTION 'wrap confirmation is immutable';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_wrap_confirmation() FROM PUBLIC;
CREATE TRIGGER immutable_wrap_confirmation BEFORE UPDATE ON public.wrap_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_wrap_confirmation();
