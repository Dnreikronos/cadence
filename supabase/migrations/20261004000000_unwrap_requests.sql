-- Stable receipt identities and confirmation timestamps, never payment amounts.
ALTER TABLE public.transfer_requests ADD COLUMN payment_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.transfer_requests ADD COLUMN paid_at timestamptz;
ALTER TABLE public.payments ADD COLUMN payment_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.payments ADD COLUMN paid_at timestamptz;
-- The retry trigger snapshots OLD.* into this table; preserve its column shape.
ALTER TABLE public.payment_attempts ADD COLUMN payment_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.payment_attempts ADD COLUMN paid_at timestamptz;
CREATE UNIQUE INDEX transfer_payment_identity ON public.transfer_requests(payment_id);
CREATE UNIQUE INDEX run_payment_identity ON public.payments(payment_id);
CREATE INDEX received_transfer_history ON public.transfer_requests(destination) WHERE signature IS NOT NULL;
CREATE INDEX received_run_history ON public.payments(destination) WHERE status = 'finalized';

-- Existing receipts have no confirmation timestamp. Their preparation timestamp
-- is the historical fallback; newly confirmed receipts use the actual record time.
-- Keep old immutable receipts untouched; the history reader applies the fallback.

CREATE FUNCTION public.stamp_received_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_TABLE_NAME = 'transfer_requests' THEN
        IF OLD.signature IS NULL AND NEW.signature IS NOT NULL THEN
            NEW.paid_at := clock_timestamp();
        END IF;
    ELSE
        IF OLD.status = 'prepared' AND NEW.status = 'finalized' THEN
            NEW.paid_at := clock_timestamp();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_received_payment() FROM PUBLIC;
CREATE TRIGGER zz_stamp_received_transfer BEFORE UPDATE ON public.transfer_requests
    FOR EACH ROW EXECUTE FUNCTION public.stamp_received_payment();
CREATE TRIGGER zz_stamp_received_run_payment BEFORE UPDATE ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.stamp_received_payment();

CREATE TABLE public.unwrap_requests (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    wallet text NOT NULL,
    source text NOT NULL CHECK (source ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    destination text NOT NULL CHECK (destination ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    transaction text NOT NULL CHECK (length(transaction) BETWEEN 1 AND 5464),
    last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height >= 0),
    signature text UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    slot bigint CHECK (slot >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (wallet, user_id) REFERENCES public.proof_wallets(wallet, user_id),
    CHECK ((signature IS NULL) = (slot IS NULL))
);
ALTER TABLE public.unwrap_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.unwrap_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.unwrap_requests TO cadence_transfer_service;
GRANT INSERT (id, user_id, wallet, source, destination, transaction, last_valid_block_height)
    ON public.unwrap_requests TO cadence_transfer_service;
GRANT UPDATE (signature, slot) ON public.unwrap_requests TO cadence_transfer_service;
CREATE POLICY unwrap_read ON public.unwrap_requests FOR SELECT
    TO cadence_transfer_service USING (true);
CREATE POLICY unwrap_prepare ON public.unwrap_requests FOR INSERT
    TO cadence_transfer_service WITH CHECK (signature IS NULL AND slot IS NULL);
CREATE POLICY unwrap_confirm ON public.unwrap_requests FOR UPDATE
    TO cadence_transfer_service USING (true) WITH CHECK (signature IS NOT NULL AND slot IS NOT NULL);
CREATE TRIGGER immutable_unwrap_confirmation BEFORE UPDATE ON public.unwrap_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_transfer_confirmation();
