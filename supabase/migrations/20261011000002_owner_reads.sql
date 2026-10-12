CREATE TABLE cadence_private.roster_amounts (
    person_id uuid PRIMARY KEY REFERENCES public.people(id),
    secret_id uuid NOT NULL UNIQUE REFERENCES vault.secrets(id)
);
ALTER TABLE cadence_private.roster_amounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cadence_private.roster_amounts FROM PUBLIC,anon,authenticated,service_role,cadence_key_service;
CREATE TABLE cadence_private.owner_read_permits (
    id uuid PRIMARY KEY REFERENCES public.decryption_audit_log(id),
    user_id uuid NOT NULL,
    company_id uuid NOT NULL,
    scope text NOT NULL CHECK (scope IN ('company','me','roster')),
    item_ids uuid[] NOT NULL CHECK (cardinality(item_ids)<=10001),
    page_size integer NOT NULL CHECK (page_size BETWEEN 1 AND 10000),
    issued_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
ALTER TABLE cadence_private.owner_read_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cadence_private.owner_read_permits FROM PUBLIC,anon,authenticated,service_role,cadence_key_service;

CREATE FUNCTION cadence_private.audit_owner_read(p_scope text,p_limit integer,p_cursor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid; v_company uuid; v_role text; v_account text; v_items uuid[];
BEGIN
    SELECT m.company_id,m.role::text INTO v_company,v_role FROM public.memberships m WHERE m.user_id=auth.uid();
    IF p_scope IN ('company','roster') AND v_role='admin' THEN
        NULL;
    ELSIF p_scope='me' AND v_role='recipient' THEN
        SELECT a.token_account INTO STRICT v_account FROM public.proof_accounts a WHERE a.user_id=auth.uid() AND a.ready;
    ELSE RAISE EXCEPTION USING MESSAGE='read access denied',ERRCODE='CD403';
    END IF;
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'invalid page'; END IF;
    IF p_scope='roster' THEN
        SELECT coalesce(array_agg(x.id ORDER BY x.id),ARRAY[]::uuid[]) INTO v_items FROM
            (SELECT p.id FROM public.people p WHERE p.company_id=v_company AND p.status<>'removed'
             AND (p_cursor IS NULL OR p.id>p_cursor::uuid) ORDER BY p.id LIMIT p_limit+1) x;
    ELSE
        SELECT coalesce(array_agg(x.payment_id ORDER BY x.payment_id),ARRAY[]::uuid[]) INTO v_items FROM
            (SELECT r.payment_id FROM cadence_private.company_payment_receipts r
             WHERE ((p_scope='company' AND r.company_id=v_company) OR (p_scope='me' AND r.destination=v_account))
             AND (p_cursor IS NULL OR r.payment_id>p_cursor::uuid) ORDER BY r.payment_id LIMIT p_limit+1) x;
    END IF;
    DELETE FROM cadence_private.owner_read_permits WHERE expires_at<=clock_timestamp();
    IF p_scope='me' THEN
        INSERT INTO public.decryption_audit_log(actor,reason,target_account) VALUES(auth.uid()::text,CASE WHEN p_limit=10000 THEN 'export recipient payments' ELSE 'read recipient payments' END,v_account) RETURNING id INTO v_id;
    ELSE
        INSERT INTO public.decryption_audit_log(actor,reason,target_company) VALUES(auth.uid()::text,CASE WHEN p_limit=10000 THEN 'export company payments' ELSE 'read company ' || p_scope END,v_company) RETURNING id INTO v_id;
    END IF;
    INSERT INTO cadence_private.owner_read_permits(id,user_id,company_id,scope,item_ids,page_size) VALUES(v_id,auth.uid(),v_company,p_scope,v_items,p_limit);
    RETURN v_id::text;
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE='CD403' THEN RAISE EXCEPTION USING MESSAGE='read access denied',ERRCODE='CD403'; END IF;
    RAISE EXCEPTION USING MESSAGE='read could not be audited',ERRCODE='P0001';
END;
$$;

CREATE FUNCTION cadence_private.consume_owner_permit(p_permit text,p_scope text)
RETURNS cadence_private.owner_read_permits LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_permit cadence_private.owner_read_permits;
BEGIN
    DELETE FROM cadence_private.owner_read_permits p WHERE p.id=p_permit::uuid AND p.user_id=auth.uid()
        AND p.scope=p_scope AND p.expires_at>clock_timestamp() AND p.issued_xid<>pg_current_xact_id()
        AND pg_visible_in_snapshot(p.issued_xid,pg_current_snapshot()) RETURNING p.* INTO STRICT v_permit;
    IF NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id=auth.uid() AND m.company_id=v_permit.company_id
        AND m.role::text=CASE WHEN p_scope='me' THEN 'recipient' ELSE 'admin' END) THEN
        RAISE EXCEPTION USING MESSAGE='read access denied',ERRCODE='CD403';
    END IF;
    RETURN v_permit;
END;
$$;

CREATE FUNCTION cadence_private.read_owner_payments(p_permit text,p_scope text)
RETURNS TABLE(payment_id text,run_id text,signature text,paid_at text,transaction text,sender text,destination text,
    public_key bytea,secret bytea,counterparty_id text,counterparty_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_permit cadence_private.owner_read_permits; v_row record; v_key cadence_private.viewing_keys;
    v_payload text; v_prefix text; v_wallet text; v_account text;
BEGIN
    IF p_scope NOT IN ('company','me') THEN RAISE EXCEPTION 'invalid scope'; END IF;
    v_permit:=cadence_private.consume_owner_permit(p_permit,p_scope);
    IF v_permit.page_size=10000 AND cardinality(v_permit.item_ids)>10000 THEN
        RAISE EXCEPTION USING MESSAGE='export too large',ERRCODE='CD413';
    END IF;
    IF p_scope='me' THEN
        SELECT a.wallet,a.token_account INTO STRICT v_wallet,v_account FROM public.proof_accounts a WHERE a.user_id=auth.uid() AND a.ready;
    END IF;
    FOR v_row IN SELECT r.* FROM cadence_private.company_payment_receipts r WHERE r.payment_id=ANY(v_permit.item_ids) ORDER BY r.payment_id LOOP
        payment_id:=v_row.payment_id::text;run_id:=v_row.run_id::text;signature:=v_row.signature;
        paid_at:=to_char(v_row.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
        transaction:=v_row.transaction;sender:=v_row.sender;destination:=v_row.destination;
        IF v_row.transparent OR v_row.payment_id=v_permit.item_ids[v_permit.page_size+1] THEN public_key:=NULL;secret:=NULL;
        ELSE
            SELECT * INTO STRICT v_key FROM cadence_private.viewing_keys k WHERE
                k.wallet=CASE WHEN p_scope='me' THEN v_wallet ELSE v_row.wallet END AND
                k.token_account=CASE WHEN p_scope='me' THEN v_account ELSE v_row.sender END;
            SELECT s.decrypted_secret INTO STRICT v_payload FROM vault.decrypted_secrets s WHERE s.id=v_key.secret_id;
            v_prefix:=v_key.format_version::text || ':' || v_key.wallet || ':' || v_key.token_account || ':' || encode(v_key.public_key,'hex') || ':';
            IF left(v_payload,length(v_prefix))<>v_prefix THEN RAISE EXCEPTION 'key context mismatch'; END IF;
            public_key:=v_key.public_key;secret:=decode(substr(v_payload,length(v_prefix)+1),'base64');
            IF octet_length(secret)<>32 THEN RAISE EXCEPTION 'invalid key'; END IF;
        END IF;
        IF p_scope='company' THEN
            SELECT p.id::text,p.name INTO counterparty_id,counterparty_name FROM public.people p
                JOIN public.proof_accounts a ON a.user_id=p.user_id WHERE a.token_account=v_row.destination AND p.company_id=v_permit.company_id;
            counterparty_name:=coalesce(counterparty_name,v_row.destination);
        ELSE
            SELECT c.id::text,c.name INTO counterparty_id,counterparty_name FROM public.companies c WHERE c.id=v_row.company_id;
            counterparty_name:=coalesce(counterparty_name,v_row.wallet);
        END IF;
        RETURN NEXT;
    END LOOP;
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('CD403','CD413') THEN RAISE EXCEPTION USING MESSAGE='read unavailable',ERRCODE=SQLSTATE; END IF;
    RAISE EXCEPTION USING MESSAGE='payments could not be read',ERRCODE='P0001';
END;
$$;

CREATE FUNCTION cadence_private.store_roster_amount(p_person text,p_amount text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_company uuid;v_secret uuid;
BEGIN
    SELECT m.company_id INTO v_company FROM public.memberships m WHERE m.user_id=auth.uid() AND m.role='admin';
    IF v_company IS NULL THEN RAISE EXCEPTION USING MESSAGE='read access denied',ERRCODE='CD403'; END IF;
    PERFORM 1 FROM public.people p WHERE p.id=p_person::uuid AND p.company_id=v_company AND p.status<>'removed' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='person not found',ERRCODE='CD404'; END IF;
    IF p_amount !~ '^[0-9]{1,15}$' OR p_amount::numeric NOT BETWEEN 1 AND 281474976710655 THEN RAISE EXCEPTION 'invalid amount'; END IF;
    SELECT r.secret_id INTO v_secret FROM cadence_private.roster_amounts r WHERE r.person_id=p_person::uuid;
    IF v_secret IS NULL THEN
        v_secret:=vault.create_secret('');
        INSERT INTO cadence_private.roster_amounts VALUES(p_person::uuid,v_secret);
    END IF;
    PERFORM vault.update_secret(v_secret,'roster:1:' || v_company::text || ':' || p_person || ':' || p_amount);
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('CD403','CD404') THEN RAISE EXCEPTION USING MESSAGE='roster access denied',ERRCODE=SQLSTATE; END IF;
    RAISE EXCEPTION USING MESSAGE='roster amount could not be stored',ERRCODE='P0001';
END;
$$;

CREATE FUNCTION cadence_private.read_roster_amounts(p_permit text)
RETURNS TABLE(person_id text,token_account text,amount text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_permit cadence_private.owner_read_permits;v_row record;v_payload text;v_prefix text;
BEGIN
    v_permit:=cadence_private.consume_owner_permit(p_permit,'roster');
    FOR v_row IN SELECT p.id,a.token_account,a.ready,r.secret_id FROM public.people p
        LEFT JOIN public.proof_accounts a ON a.user_id=p.user_id LEFT JOIN cadence_private.roster_amounts r ON r.person_id=p.id
        WHERE p.id=ANY(v_permit.item_ids) AND p.company_id=v_permit.company_id ORDER BY p.id LOOP
        person_id:=v_row.id::text;token_account:=CASE WHEN v_row.ready THEN v_row.token_account END;amount:=NULL;
        IF v_row.secret_id IS NOT NULL AND v_row.id IS DISTINCT FROM v_permit.item_ids[v_permit.page_size+1] THEN
            SELECT s.decrypted_secret INTO STRICT v_payload FROM vault.decrypted_secrets s WHERE s.id=v_row.secret_id;
            v_prefix:='roster:1:' || v_permit.company_id::text || ':' || person_id || ':';
            IF left(v_payload,length(v_prefix))<>v_prefix THEN RAISE EXCEPTION 'roster context mismatch'; END IF;
            amount:=substr(v_payload,length(v_prefix)+1);
            IF amount !~ '^[0-9]{1,15}$' OR amount::numeric NOT BETWEEN 1 AND 281474976710655 THEN RAISE EXCEPTION 'invalid amount'; END IF;
        END IF;
        RETURN NEXT;
    END LOOP;
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE='CD403' THEN RAISE EXCEPTION USING MESSAGE='read access denied',ERRCODE='CD403'; END IF;
    RAISE EXCEPTION USING MESSAGE='roster amounts could not be read',ERRCODE='P0001';
END;
$$;
REVOKE ALL ON FUNCTION cadence_private.consume_owner_permit(text,text) FROM PUBLIC,anon,authenticated,service_role,cadence_key_service;
REVOKE ALL ON FUNCTION cadence_private.audit_owner_read(text,integer,text),cadence_private.read_owner_payments(text,text),
    cadence_private.store_roster_amount(text,text),cadence_private.read_roster_amounts(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cadence_private.audit_owner_read(text,integer,text),cadence_private.read_owner_payments(text,text),
    cadence_private.store_roster_amount(text,text),cadence_private.read_roster_amounts(text) TO cadence_key_service;
