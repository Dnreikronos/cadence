-- Run metadata and public ciphertext only. Reuse the isolated transfer runtime.
CREATE TABLE public.runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    company_wallet text NOT NULL,
    sender text NOT NULL CHECK (sender ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (company_wallet, user_id) REFERENCES public.proof_wallets(wallet, user_id)
);

CREATE TABLE public.payments (
    run_id uuid NOT NULL REFERENCES public.runs(id),
    position smallint NOT NULL CHECK (position BETWEEN 0 AND 99),
    destination text NOT NULL CHECK (destination ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    request_id text UNIQUE CHECK (request_id ~ '^[0-9a-f]{64}$'),
    transaction text CHECK (length(transaction) BETWEEN 1 AND 5464),
    last_valid_block_height bigint CHECK (last_valid_block_height >= 0),
    status text NOT NULL CHECK (status IN ('prepared', 'finalized', 'failed', 'expired', 'preparation_failed')),
    signature text UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    slot bigint CHECK (slot >= 0),
    error text CHECK (error ~ '^[a-z_]{1,64}$'),
    PRIMARY KEY (run_id, position),
    UNIQUE (run_id, destination),
    CHECK ((transaction IS NULL) = (request_id IS NULL)),
    CHECK ((transaction IS NULL) = (last_valid_block_height IS NULL)),
    CHECK (
        (status = 'preparation_failed' AND transaction IS NULL AND signature IS NULL AND slot IS NULL AND error IS NOT NULL) OR
        (status = 'prepared' AND transaction IS NOT NULL AND signature IS NULL AND slot IS NULL AND error IS NULL) OR
        (status = 'finalized' AND transaction IS NOT NULL AND signature IS NOT NULL AND slot IS NOT NULL AND error IS NULL) OR
        (status = 'failed' AND transaction IS NOT NULL AND signature IS NOT NULL AND slot IS NOT NULL AND error = 'transaction_failed') OR
        (status = 'expired' AND transaction IS NOT NULL AND signature IS NOT NULL AND slot IS NULL AND error = 'transaction_expired')
    )
);

-- Retain old attempts so a retry cannot erase a chain receipt.
CREATE TABLE public.payment_attempts (LIKE public.payments INCLUDING CONSTRAINTS);
ALTER TABLE public.payment_attempts ADD PRIMARY KEY (run_id, position, attempt);
ALTER TABLE public.payment_attempts ADD FOREIGN KEY (run_id, position)
    REFERENCES public.payments(run_id, position);

ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runs, public.payments, public.payment_attempts
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.runs, public.payments, public.payment_attempts TO cadence_transfer_service;
GRANT INSERT (user_id, company_wallet, sender) ON public.runs TO cadence_transfer_service;
GRANT INSERT (run_id, position, destination, request_id, transaction, last_valid_block_height, status, error)
    ON public.payments TO cadence_transfer_service;
GRANT UPDATE (attempt, request_id, transaction, last_valid_block_height, status, signature, slot, error)
    ON public.payments TO cadence_transfer_service;
CREATE POLICY runs_service ON public.runs TO cadence_transfer_service USING (true) WITH CHECK (true);
CREATE POLICY payments_service ON public.payments TO cadence_transfer_service USING (true) WITH CHECK (true);
CREATE POLICY attempts_service_read ON public.payment_attempts FOR SELECT TO cadence_transfer_service USING (true);

GRANT SELECT ON public.runs, public.payments TO authenticated;
CREATE POLICY runs_owner_read ON public.runs FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));
CREATE POLICY payments_owner_read ON public.payments FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.runs r WHERE r.id = run_id AND r.user_id = (SELECT auth.uid())));

CREATE FUNCTION public.guard_run_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.position IS DISTINCT FROM OLD.position
       OR NEW.destination IS DISTINCT FROM OLD.destination THEN
        RAISE EXCEPTION 'payment identity is immutable';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
    END IF;
    IF NEW.attempt = OLD.attempt + 1 AND OLD.status IN ('failed', 'expired', 'preparation_failed')
       AND NEW.status IN ('prepared', 'preparation_failed') AND NEW.signature IS NULL AND NEW.slot IS NULL THEN
        INSERT INTO public.payment_attempts SELECT OLD.*;
        RETURN NEW;
    END IF;
    IF OLD.status <> 'prepared' OR NEW.attempt <> OLD.attempt
       OR NEW.status NOT IN ('finalized', 'failed', 'expired')
       OR NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.transaction IS DISTINCT FROM OLD.transaction
       OR NEW.last_valid_block_height IS DISTINCT FROM OLD.last_valid_block_height THEN
        RAISE EXCEPTION 'payment attempt is immutable';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_run_payment() FROM PUBLIC;
CREATE TRIGGER guard_run_payment BEFORE UPDATE ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.guard_run_payment();
