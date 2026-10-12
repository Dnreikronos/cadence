-- Normal pages remain limited to 100; a dedicated export captures at most
-- 10,000 receipts plus one lookahead under a single committed audit record.
ALTER TABLE cadence_private.company_read_permits DROP CONSTRAINT company_read_permits_payment_ids_check;
ALTER TABLE cadence_private.company_read_permits ADD CHECK (cardinality(payment_ids)<=10001);
ALTER TABLE cadence_private.company_read_permits DROP CONSTRAINT company_read_permits_page_size_check;
ALTER TABLE cadence_private.company_read_permits ADD CHECK (page_size BETWEEN 1 AND 10000);
CREATE FUNCTION cadence_private.audit_company_export(p_company text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;v_payments uuid[];
BEGIN
    IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.auditor_grants g
        JOIN public.memberships m ON m.user_id=g.user_id AND m.company_id=g.company_id AND m.role='auditor'
        WHERE g.user_id=auth.uid() AND g.company_id=p_company::uuid) THEN
        RAISE EXCEPTION USING MESSAGE='audit scope not found',ERRCODE='CD404';
    END IF;
    SELECT coalesce(array_agg(x.payment_id ORDER BY x.payment_id),ARRAY[]::uuid[]) INTO v_payments FROM
        (SELECT r.payment_id FROM cadence_private.company_payment_receipts r WHERE r.company_id=p_company::uuid ORDER BY r.payment_id LIMIT 10001) x;
    DELETE FROM cadence_private.company_read_permits WHERE expires_at<=clock_timestamp();
    INSERT INTO public.decryption_audit_log(actor,reason,target_company) VALUES(auth.uid()::text,'export company payments',p_company::uuid) RETURNING id INTO v_id;
    INSERT INTO cadence_private.company_read_permits(id,user_id,company_id,payment_ids,page_size) VALUES(v_id,auth.uid(),p_company::uuid,v_payments,10000);
    RETURN v_id::text;
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE='CD404' THEN RAISE EXCEPTION USING MESSAGE='audit scope not found',ERRCODE='CD404'; END IF;
    RAISE EXCEPTION USING MESSAGE='export could not be audited',ERRCODE='P0001';
END;
$$;
REVOKE ALL ON FUNCTION cadence_private.audit_company_export(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cadence_private.audit_company_export(text) TO cadence_audit_service;

CREATE FUNCTION cadence_private.read_company_export(p_company text,p_permit text)
RETURNS TABLE(payment_id text,run_id text,destination text,signature text,paid_at text,
    transaction text,sender text,public_key bytea,secret bytea,person_id text,person_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer;
BEGIN
    IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.auditor_grants g
        JOIN public.memberships m ON m.user_id=g.user_id AND m.company_id=g.company_id AND m.role='auditor'
        WHERE g.user_id=auth.uid() AND g.company_id=p_company::uuid) THEN
        RAISE EXCEPTION USING MESSAGE='audit scope not found',ERRCODE='CD404';
    END IF;
    SELECT cardinality(p.payment_ids) INTO STRICT v_count FROM cadence_private.company_read_permits p
        WHERE p.id=p_permit::uuid AND p.user_id=auth.uid() AND p.company_id=p_company::uuid
        AND p.page_size=10000 AND p.expires_at>clock_timestamp()
        AND p.issued_xid<>pg_current_xact_id() AND pg_visible_in_snapshot(p.issued_xid,pg_current_snapshot());
    IF v_count>10000 THEN RAISE EXCEPTION USING MESSAGE='export too large',ERRCODE='CD413'; END IF;
    RETURN QUERY SELECT * FROM cadence_private.read_company_payments(p_company,p_permit);
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('CD404','CD413') THEN RAISE EXCEPTION USING MESSAGE='export unavailable',ERRCODE=SQLSTATE; END IF;
    RAISE EXCEPTION USING MESSAGE='export could not be read',ERRCODE='P0001';
END;
$$;
REVOKE ALL ON FUNCTION cadence_private.read_company_export(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cadence_private.read_company_export(text,text) TO cadence_audit_service;
