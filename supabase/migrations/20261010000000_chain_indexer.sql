-- Submission evidence and terminal receipts contain public metadata only.
CREATE ROLE cadence_indexer NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO cadence_indexer;

ALTER TABLE public.payments ADD COLUMN submitted_signature text
    CHECK (submitted_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
ALTER TABLE public.payment_attempts ADD COLUMN submitted_signature text
    CHECK (submitted_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['wrap_requests', 'transfer_requests', 'unwrap_requests'] LOOP
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN submitted_signature text CHECK (submitted_signature ~ %L)',
                       t, '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN status text NOT NULL DEFAULT %L CHECK (status IN (%L,%L,%L))',
                       t, 'prepared', 'prepared', 'finalized', 'failed');
        EXECUTE format('UPDATE public.%I SET status = %L WHERE signature IS NOT NULL', t, 'finalized');
        -- The original signature/slot pairing still applies to terminal receipts.
        EXECUTE format('ALTER TABLE public.%I ADD CHECK ((status = %L AND signature IS NULL AND slot IS NULL) OR (status IN (%L,%L) AND signature IS NOT NULL AND slot IS NOT NULL))',
                       t, 'prepared', 'finalized', 'failed');
        EXECUTE format('GRANT SELECT ON public.%I TO cadence_indexer', t);
        EXECUTE format('GRANT UPDATE (signature, slot, status) ON public.%I TO cadence_indexer', t);
        EXECUTE format('CREATE POLICY indexer_receipts ON public.%I TO cadence_indexer USING (true) WITH CHECK (true)', t);
    END LOOP;
END;
$$;

GRANT SELECT ON public.runs, public.payments TO cadence_indexer;
GRANT UPDATE (status, signature, slot, error) ON public.payments TO cadence_indexer;
CREATE POLICY indexer_runs ON public.runs FOR SELECT TO cadence_indexer USING (true);
CREATE POLICY indexer_payments ON public.payments TO cadence_indexer USING (true) WITH CHECK (true);
GRANT UPDATE (submitted_signature) ON public.payments, public.transfer_requests, public.unwrap_requests
    TO cadence_transfer_service;
GRANT UPDATE (submitted_signature) ON public.wrap_requests TO cadence_wrap_service;

-- A signature is verified against the prepared message in Rust before tracking.
-- Once tracked, neither a second client nor a late indexer may replace it.
CREATE FUNCTION public.guard_indexed_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF OLD.signature IS NOT NULL THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'terminal receipt is immutable';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.submitted_signature IS NOT NULL AND
       NEW.submitted_signature IS DISTINCT FROM OLD.submitted_signature THEN
        RAISE EXCEPTION 'submission is immutable';
    END IF;
    IF NEW.signature IS NOT NULL THEN
        IF OLD.submitted_signature IS NOT NULL AND NEW.signature <> OLD.submitted_signature THEN
            RAISE EXCEPTION 'receipt signature does not match submission';
        END IF;
        IF NEW.status = 'prepared' THEN NEW.status := 'finalized'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_indexed_receipt() FROM PUBLIC;
CREATE TRIGGER indexed_wrap_receipt BEFORE UPDATE ON public.wrap_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_indexed_receipt();
CREATE TRIGGER indexed_transfer_receipt BEFORE UPDATE ON public.transfer_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_indexed_receipt();
CREATE TRIGGER indexed_unwrap_receipt BEFORE UPDATE ON public.unwrap_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_indexed_receipt();

DROP POLICY wrap_service_confirm ON public.wrap_requests;
CREATE POLICY wrap_service_confirm ON public.wrap_requests FOR UPDATE TO cadence_wrap_service
    USING (true) WITH CHECK (true);
DROP POLICY transfer_confirm ON public.transfer_requests;
CREATE POLICY transfer_confirm ON public.transfer_requests FOR UPDATE TO cadence_transfer_service
    USING (true) WITH CHECK (true);
DROP POLICY unwrap_confirm ON public.unwrap_requests;
CREATE POLICY unwrap_confirm ON public.unwrap_requests FOR UPDATE TO cadence_transfer_service
    USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.guard_run_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.position IS DISTINCT FROM OLD.position
       OR NEW.destination IS DISTINCT FROM OLD.destination
       OR NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
        RAISE EXCEPTION 'payment identity is immutable';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF NEW.attempt = OLD.attempt + 1 AND OLD.status IN ('failed', 'expired', 'preparation_failed')
       AND NEW.status IN ('prepared', 'preparation_failed') AND NEW.signature IS NULL
       AND NEW.slot IS NULL AND NEW.submitted_signature IS NULL THEN
        INSERT INTO public.payment_attempts SELECT OLD.*;
        RETURN NEW;
    END IF;
    IF OLD.status <> 'prepared' OR NEW.attempt <> OLD.attempt
       OR NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.transaction IS DISTINCT FROM OLD.transaction
       OR NEW.last_valid_block_height IS DISTINCT FROM OLD.last_valid_block_height
       OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
       OR (OLD.submitted_signature IS NOT NULL AND
           NEW.submitted_signature IS DISTINCT FROM OLD.submitted_signature) THEN
        RAISE EXCEPTION 'payment attempt is immutable';
    END IF;
    IF NEW.status = 'prepared' THEN RETURN NEW; END IF;
    IF NEW.status NOT IN ('finalized', 'failed', 'expired') OR
       (OLD.submitted_signature IS NOT NULL AND NEW.signature <> OLD.submitted_signature) THEN
        RAISE EXCEPTION 'receipt signature does not match submission';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.stamp_received_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF OLD.status = 'prepared' AND NEW.status = 'finalized' THEN
        NEW.paid_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;
DROP INDEX public.received_transfer_history;
CREATE INDEX received_transfer_history ON public.transfer_requests(destination) WHERE status = 'finalized';

CREATE TABLE public.indexer_cursors (
    wallet text PRIMARY KEY CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    signature text NOT NULL CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$')
);
ALTER TABLE public.indexer_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.indexer_cursors FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.indexer_cursors TO cadence_indexer;
CREATE POLICY indexer_cursors_service ON public.indexer_cursors TO cadence_indexer USING (true) WITH CHECK (true);

CREATE TABLE public.payment_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('run', 'wrap', 'transfer', 'unwrap')),
    request_id text NOT NULL CHECK (request_id ~ '^[0-9a-f]{64}$'),
    user_id uuid,
    wallet text NOT NULL,
    destination text NOT NULL,
    run_id uuid,
    position smallint,
    attempt integer NOT NULL,
    status text NOT NULL CHECK (status IN ('finalized', 'failed')),
    signature text NOT NULL,
    slot bigint NOT NULL CHECK (slot >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (kind, request_id)
);
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.payment_events TO cadence_indexer;
CREATE POLICY indexer_events_read ON public.payment_events FOR SELECT TO cadence_indexer USING (true);

CREATE FUNCTION public.emit_indexed_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner_id uuid; owner_wallet text; event_kind text;
BEGIN
    IF OLD.status <> 'prepared' OR NEW.status NOT IN ('finalized', 'failed') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'payments' THEN
        SELECT user_id, company_wallet INTO owner_id, owner_wallet FROM public.runs WHERE id = NEW.run_id;
        INSERT INTO public.payment_events (kind, request_id, user_id, wallet, destination, run_id, position, attempt, status, signature, slot)
        VALUES ('run', NEW.request_id, owner_id, owner_wallet, NEW.destination, NEW.run_id, NEW.position, NEW.attempt, NEW.status, NEW.signature, NEW.slot);
    ELSE
        event_kind := CASE TG_TABLE_NAME WHEN 'wrap_requests' THEN 'wrap'
                       WHEN 'transfer_requests' THEN 'transfer' ELSE 'unwrap' END;
        IF event_kind = 'wrap' THEN owner_id := NULL; owner_wallet := NEW.company_wallet;
        ELSIF event_kind = 'transfer' THEN owner_id := NEW.user_id; owner_wallet := NEW.company_wallet;
        ELSE owner_id := NEW.user_id; owner_wallet := NEW.wallet; END IF;
        INSERT INTO public.payment_events (kind, request_id, user_id, wallet, destination, attempt, status, signature, slot)
        VALUES (event_kind, NEW.id, owner_id, owner_wallet, NEW.destination, 0, NEW.status, NEW.signature, NEW.slot);
    END IF;
    -- Only a wakeup: the durable event row is the notification contract.
    PERFORM pg_notify('cadence_payment_events', '');
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.emit_indexed_payment() FROM PUBLIC;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['payments', 'wrap_requests', 'transfer_requests', 'unwrap_requests'] LOOP
        EXECUTE format('CREATE TRIGGER emit_indexed_payment AFTER UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.emit_indexed_payment()', t);
    END LOOP;
    IF EXISTS (SELECT FROM pg_publication WHERE pubname = 'supabase_realtime') AND
       NOT EXISTS (SELECT FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'payments') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.payments;
    END IF;
END;
$$;

-- Tracked submissions must survive downtime longer than the unsigned TTL.
CREATE OR REPLACE FUNCTION public.cleanup_wrap_requests(finalized_height bigint) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    WITH expired AS (
        SELECT id FROM public.wrap_requests WHERE signature IS NULL AND submitted_signature IS NULL
          AND last_valid_block_height < finalized_height
          AND created_at < clock_timestamp() - interval '24 hours'
        ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED
    ), removed AS (
        DELETE FROM public.wrap_requests AS requests USING expired
        WHERE requests.id = expired.id AND requests.signature IS NULL AND requests.submitted_signature IS NULL
        RETURNING requests.id
    ) SELECT count(*) FROM removed;
$$;
