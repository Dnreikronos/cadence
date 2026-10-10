-- Company attribution is captured at preparation, never inferred at read time.
ALTER TABLE public.runs ADD COLUMN company_id uuid REFERENCES public.companies(id);
ALTER TABLE public.transfer_requests ADD COLUMN company_id uuid REFERENCES public.companies(id);

CREATE FUNCTION public.attribute_company_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT m.company_id INTO NEW.company_id FROM public.memberships m
            WHERE m.user_id = NEW.user_id AND m.role = 'admin';
    ELSIF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.company_wallet IS DISTINCT FROM OLD.company_wallet
       OR NEW.sender IS DISTINCT FROM OLD.sender THEN
        RAISE EXCEPTION 'company payment attribution is immutable';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.attribute_company_payment() FROM PUBLIC;
CREATE TRIGGER attribute_run_company BEFORE INSERT OR UPDATE ON public.runs
    FOR EACH ROW EXECUTE FUNCTION public.attribute_company_payment();
CREATE TRIGGER attribute_transfer_company BEFORE INSERT OR UPDATE ON public.transfer_requests
    FOR EACH ROW EXECUTE FUNCTION public.attribute_company_payment();

CREATE ROLE cadence_audit_service NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public, auth, cadence_rls, cadence_private TO cadence_audit_service;
GRANT EXECUTE ON FUNCTION auth.uid(), cadence_rls.current_membership() TO cadence_audit_service;
GRANT SELECT ON public.memberships TO cadence_audit_service;
CREATE POLICY audit_membership_read ON public.memberships FOR SELECT TO cadence_audit_service
    USING (user_id = (SELECT auth.uid()) OR company_id IN
        (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin'));

ALTER TABLE public.memberships ADD CONSTRAINT memberships_grant_identity
    UNIQUE (user_id, company_id, role);
CREATE TABLE public.auditor_grants (
    id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id),
    user_id uuid NOT NULL,
    role public.membership_role NOT NULL DEFAULT 'auditor' CHECK (role = 'auditor'),
    granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (company_id, user_id),
    FOREIGN KEY (user_id, company_id, role) REFERENCES public.memberships(user_id, company_id, role)
        ON DELETE CASCADE
);
ALTER TABLE public.auditor_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auditor_grants FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON public.auditor_grants TO authenticated, cadence_audit_service;
GRANT INSERT (company_id, user_id) ON public.auditor_grants TO authenticated, cadence_audit_service;
CREATE POLICY auditor_grant_read ON public.auditor_grants FOR SELECT TO authenticated, cadence_audit_service
    USING (company_id IN (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin')
        OR (user_id = (SELECT auth.uid()) AND company_id IN
            (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'auditor')));
CREATE POLICY auditor_grant_create ON public.auditor_grants FOR INSERT TO authenticated, cadence_audit_service
    WITH CHECK (company_id IN (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin'));
CREATE POLICY auditor_grant_revoke ON public.auditor_grants FOR DELETE TO authenticated, cadence_audit_service
    USING (company_id IN (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin'));

-- Existing designations and future accepted invitations become explicit grants.
INSERT INTO public.auditor_grants (company_id, user_id)
    SELECT company_id, user_id FROM public.memberships WHERE role = 'auditor';
CREATE FUNCTION public.grant_accepted_auditor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.role = 'auditor' THEN
        INSERT INTO public.auditor_grants (company_id, user_id) VALUES (NEW.company_id, NEW.user_id);
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.grant_accepted_auditor() FROM PUBLIC;
CREATE TRIGGER accepted_auditor_grant AFTER INSERT ON public.memberships
    FOR EACH ROW EXECUTE FUNCTION public.grant_accepted_auditor();

-- Company-page reads share one audit row across all sender keys and empty pages.
ALTER TABLE public.decryption_audit_log ALTER COLUMN target_account DROP NOT NULL;
ALTER TABLE public.decryption_audit_log ADD COLUMN target_company uuid REFERENCES public.companies(id);
ALTER TABLE public.decryption_audit_log ADD CONSTRAINT audit_exactly_one_target
    CHECK (num_nonnulls(target_account, target_company) = 1);

CREATE VIEW cadence_private.company_payment_receipts AS
    SELECT p.payment_id, r.company_id, r.company_wallet AS wallet, r.sender,
        p.destination, p.transaction, p.run_id, p.signature,
        coalesce(p.paid_at, r.created_at) AS paid_at
    FROM public.payments p JOIN public.runs r ON r.id = p.run_id WHERE p.status = 'finalized'
    UNION ALL
    SELECT t.payment_id, t.company_id, t.company_wallet, t.sender,
        t.destination, t.transaction, NULL::uuid, t.signature, coalesce(t.paid_at, t.created_at)
    FROM public.transfer_requests t WHERE t.status = 'finalized';
REVOKE ALL ON cadence_private.company_payment_receipts FROM PUBLIC, anon, authenticated, service_role, cadence_audit_service;

CREATE TABLE cadence_private.company_read_permits (
    id uuid PRIMARY KEY REFERENCES public.decryption_audit_log(id),
    user_id uuid NOT NULL,
    company_id uuid NOT NULL,
    payment_ids uuid[] NOT NULL CHECK (cardinality(payment_ids) <= 101),
    page_size integer NOT NULL CHECK (page_size BETWEEN 1 AND 100),
    issued_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '5 minutes'
);
ALTER TABLE cadence_private.company_read_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cadence_private.company_read_permits FROM PUBLIC, anon, authenticated, service_role, cadence_audit_service;

CREATE FUNCTION cadence_private.audit_company_read(p_company text, p_limit integer, p_cursor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_payments uuid[];
BEGIN
    IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.auditor_grants g
        JOIN public.memberships m ON m.user_id = g.user_id AND m.company_id = g.company_id AND m.role = 'auditor'
        WHERE g.user_id = auth.uid() AND g.company_id = p_company::uuid) THEN
        RAISE EXCEPTION USING MESSAGE = 'audit scope not found', ERRCODE = 'CD404';
    END IF;
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'invalid page';
    END IF;
    SELECT coalesce(array_agg(page.payment_id ORDER BY page.payment_id), ARRAY[]::uuid[]) INTO v_payments
        FROM (SELECT payment_id FROM cadence_private.company_payment_receipts
            WHERE company_id = p_company::uuid AND (p_cursor IS NULL OR payment_id > p_cursor::uuid)
            ORDER BY payment_id LIMIT p_limit + 1) page;
    DELETE FROM cadence_private.company_read_permits WHERE expires_at <= clock_timestamp();
    INSERT INTO public.decryption_audit_log (actor, reason, target_company)
        VALUES (auth.uid()::text, 'read company payments', p_company::uuid) RETURNING id INTO v_id;
    INSERT INTO cadence_private.company_read_permits (id, user_id, company_id, payment_ids, page_size)
        VALUES (v_id, auth.uid(), p_company::uuid, v_payments, p_limit);
    RETURN v_id::text;
END;
$$;

CREATE FUNCTION cadence_private.read_company_payments(p_company text, p_permit text)
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
        -- The extra lookahead receipt determines pagination and needs no key.
        IF v_row.payment_id = v_permit.payment_ids[v_permit.page_size + 1] THEN
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
REVOKE ALL ON FUNCTION cadence_private.audit_company_read(text, integer, text),
    cadence_private.read_company_payments(text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cadence_private.audit_company_read(text, integer, text),
    cadence_private.read_company_payments(text, text) TO cadence_audit_service;
