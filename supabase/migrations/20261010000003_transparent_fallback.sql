-- Privacy mode belongs to an immutable attempt, including retained history.
ALTER TABLE public.payments ADD COLUMN transparent boolean NOT NULL DEFAULT false;
ALTER TABLE public.payment_attempts ADD COLUMN transparent boolean NOT NULL DEFAULT false;
ALTER TABLE public.transfer_requests ADD COLUMN transparent boolean NOT NULL DEFAULT false;
GRANT INSERT (transparent), UPDATE (transparent) ON public.payments TO cadence_transfer_service;
GRANT INSERT (transparent) ON public.transfer_requests TO cadence_transfer_service;

CREATE FUNCTION public.guard_payment_privacy() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.transparent IS DISTINCT FROM OLD.transparent THEN
        IF TG_TABLE_NAME = 'transfer_requests' THEN
            RAISE EXCEPTION 'payment privacy mode is immutable';
        ELSIF NEW.attempt = OLD.attempt THEN
            RAISE EXCEPTION 'payment privacy mode is immutable';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_payment_privacy() FROM PUBLIC;
CREATE TRIGGER guard_payment_privacy BEFORE UPDATE ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.guard_payment_privacy();
CREATE TRIGGER guard_payment_privacy BEFORE UPDATE ON public.transfer_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_payment_privacy();

-- Minimal receipt-only test fixtures do not install the auditor schema.
DO $migration$
BEGIN
    IF to_regclass('cadence_private.company_payment_receipts') IS NOT NULL THEN
        EXECUTE $view$
CREATE OR REPLACE VIEW cadence_private.company_payment_receipts AS
    SELECT p.payment_id, r.company_id, r.company_wallet AS wallet, r.sender,
        p.destination, p.transaction, p.run_id, p.signature,
        coalesce(p.paid_at, r.created_at) AS paid_at, p.transparent
    FROM public.payments p JOIN public.runs r ON r.id = p.run_id WHERE p.status = 'finalized'
    UNION ALL
    SELECT t.payment_id, t.company_id, t.company_wallet, t.sender,
        t.destination, t.transaction, NULL::uuid, t.signature, coalesce(t.paid_at, t.created_at), t.transparent
    FROM public.transfer_requests t WHERE t.status = 'finalized';
$view$;
        EXECUTE $function$
CREATE OR REPLACE FUNCTION cadence_private.read_company_payments(p_company text, p_permit text)
RETURNS TABLE (payment_id text, run_id text, destination text, signature text, paid_at text,
    transaction text, sender text, public_key bytea, secret bytea, person_id text, person_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_permit cadence_private.company_read_permits; v_row record;
    v_key cadence_private.viewing_keys; v_payload text; v_prefix text;
BEGIN
    IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.auditor_grants g
        JOIN public.memberships m ON m.user_id = g.user_id AND m.company_id = g.company_id AND m.role = 'auditor'
        WHERE g.user_id = auth.uid() AND g.company_id = p_company::uuid) THEN
        RAISE EXCEPTION USING MESSAGE = 'audit scope not found', ERRCODE = 'CD404';
    END IF;
    DELETE FROM cadence_private.company_read_permits p
        WHERE p.id = p_permit::uuid AND p.user_id = auth.uid() AND p.company_id = p_company::uuid
          AND p.expires_at > clock_timestamp() AND p.issued_xid <> pg_current_xact_id()
          AND pg_visible_in_snapshot(p.issued_xid, pg_current_snapshot()) RETURNING p.* INTO v_permit;
    IF NOT FOUND THEN RAISE EXCEPTION 'committed matching audit permit required'; END IF;
    FOR v_row IN SELECT r.* FROM cadence_private.company_payment_receipts r
        WHERE r.company_id = v_permit.company_id AND r.payment_id = ANY(v_permit.payment_ids)
        ORDER BY r.payment_id LOOP
        payment_id := v_row.payment_id::text; run_id := v_row.run_id::text;
        destination := v_row.destination; signature := v_row.signature;
        paid_at := to_char(v_row.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
        transaction := v_row.transaction; sender := v_row.sender;
        -- Public transfers and the pagination lookahead need no decryption key.
        IF v_row.transparent OR v_row.payment_id = v_permit.payment_ids[v_permit.page_size + 1] THEN
            public_key := NULL; secret := NULL;
        ELSE
            SELECT * INTO STRICT v_key FROM cadence_private.viewing_keys k
                WHERE k.wallet = v_row.wallet AND k.token_account = v_row.sender;
            SELECT decrypted_secret INTO STRICT v_payload FROM vault.decrypted_secrets WHERE id = v_key.secret_id;
            v_prefix := v_key.format_version::text || ':' || v_row.wallet || ':' || v_row.sender || ':' || encode(v_key.public_key, 'hex') || ':';
            IF left(v_payload, length(v_prefix)) <> v_prefix THEN RAISE EXCEPTION 'key context mismatch'; END IF;
            public_key := v_key.public_key;
            secret := decode(substr(v_payload, length(v_prefix) + 1), 'base64');
            IF octet_length(secret) <> 32 THEN RAISE EXCEPTION 'invalid key'; END IF;
        END IF;
        SELECT p.id::text, p.name INTO person_id, person_name FROM public.people p
            JOIN public.proof_wallets w ON w.user_id = p.user_id
            JOIN cadence_private.viewing_keys k ON k.wallet = w.wallet AND k.token_account = v_row.destination
            WHERE p.company_id = v_permit.company_id;
        RETURN NEXT;
    END LOOP;
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = 'CD404' THEN RAISE EXCEPTION USING MESSAGE = 'audit scope not found', ERRCODE = 'CD404'; END IF;
    RAISE EXCEPTION USING MESSAGE = 'company payments could not be read', ERRCODE = 'P0001';
END;
$$;
$function$;
    END IF;
END;
$migration$;
