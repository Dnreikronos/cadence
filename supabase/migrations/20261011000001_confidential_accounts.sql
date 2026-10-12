CREATE TABLE public.proof_accounts (
    wallet text PRIMARY KEY,
    token_account text NOT NULL UNIQUE CHECK (token_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id),
    ready boolean NOT NULL DEFAULT false,
    FOREIGN KEY (wallet, user_id) REFERENCES public.proof_wallets(wallet, user_id)
);
ALTER TABLE public.proof_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.proof_accounts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.proof_accounts TO cadence_transfer_service;
GRANT UPDATE (ready) ON public.proof_accounts TO cadence_transfer_service;
CREATE POLICY accounts_service ON public.proof_accounts TO cadence_transfer_service USING (true) WITH CHECK (true);
GRANT SELECT ON public.proof_accounts TO authenticated;
CREATE POLICY accounts_member_read ON public.proof_accounts FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()) OR user_id IN
        (SELECT p.user_id FROM public.people p WHERE p.company_id IN
         (SELECT company_id FROM cadence_rls.current_membership() WHERE role='admin')));
CREATE VIEW public.people_accounts WITH (security_invoker=true) AS
    SELECT p.id, p.company_id, p.name, p.status,
        CASE WHEN a.ready THEN a.token_account END AS token_account
    FROM public.people p LEFT JOIN public.proof_accounts a ON a.user_id=p.user_id;
GRANT SELECT ON public.people_accounts TO authenticated;
GRANT SELECT ON public.people TO cadence_transfer_service;
CREATE POLICY people_proof_read ON public.people FOR SELECT TO cadence_transfer_service USING (true);
GRANT UPDATE (status) ON public.people TO cadence_transfer_service;
CREATE POLICY people_proof_activate ON public.people FOR UPDATE TO cadence_transfer_service
    USING (EXISTS (SELECT 1 FROM public.proof_accounts a WHERE a.user_id=people.user_id AND a.ready))
    WITH CHECK (status='active');

CREATE OR REPLACE FUNCTION public.guard_person_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.status = OLD.status THEN RETURN NEW; END IF;
    IF current_user = 'service_role' THEN
        IF OLD.status='pending' AND NEW.status='active' THEN RETURN NEW; END IF;
    ELSIF current_user = 'cadence_transfer_service' THEN
        IF OLD.status='pending' AND NEW.status='active'
            AND EXISTS (SELECT 1 FROM public.proof_accounts a WHERE a.user_id=NEW.user_id AND a.ready) THEN
            RETURN NEW;
        END IF;
    ELSIF NEW.status='removed' THEN RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid person status transition' USING ERRCODE='23514';
END;
$$;

CREATE TABLE cadence_private.balance_keys (
    token_account text PRIMARY KEY REFERENCES cadence_private.viewing_keys(token_account),
    secret_id uuid NOT NULL UNIQUE REFERENCES vault.secrets(id)
);
ALTER TABLE cadence_private.balance_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cadence_private.balance_keys FROM PUBLIC, anon, authenticated, service_role, cadence_key_service;

CREATE FUNCTION cadence_private.account_key_metadata(p_wallet text, p_account text)
RETURNS TABLE (public_key bytea, balance_key_enrolled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    SELECT k.public_key, EXISTS (SELECT 1 FROM cadence_private.balance_keys b WHERE b.token_account=k.token_account)
    FROM cadence_private.viewing_keys k WHERE k.wallet=p_wallet AND k.token_account=p_account;
$$;

CREATE FUNCTION cadence_private.store_account_keys(p_wallet text, p_account text, p_public bytea, p_secret text, p_balance text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_public bytea; v_id uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('account-key:' || p_account, 0));
    IF octet_length(decode(p_balance,'base64')) <> 16 THEN RAISE EXCEPTION 'invalid balance key'; END IF;
    SELECT k.public_key INTO v_public FROM cadence_private.viewing_keys k WHERE k.token_account=p_account AND k.wallet=p_wallet;
    IF FOUND THEN
        IF v_public <> p_public THEN RAISE EXCEPTION 'key context mismatch'; END IF;
    ELSE
        PERFORM cadence_private.store_viewing_key(p_wallet,p_account,p_public,p_secret);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cadence_private.balance_keys b WHERE b.token_account=p_account) THEN
        v_id := vault.create_secret('');
        PERFORM vault.update_secret(v_id,'balance:1:' || p_wallet || ':' || p_account || ':' || p_balance);
        INSERT INTO cadence_private.balance_keys VALUES (p_account,v_id);
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING MESSAGE='account keys could not be stored', ERRCODE='P0001';
END;
$$;

CREATE FUNCTION cadence_private.read_account_keys(p_wallet text, p_account text, p_permit text)
RETURNS TABLE (public_key bytea, secret bytea, balance_key bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key record; v_payload text; v_prefix text;
BEGIN
    SELECT * INTO STRICT v_key FROM cadence_private.read_viewing_key(p_wallet,p_account,p_permit);
    SELECT s.decrypted_secret INTO STRICT v_payload FROM cadence_private.balance_keys b
        JOIN vault.decrypted_secrets s ON s.id=b.secret_id WHERE b.token_account=p_account;
    v_prefix := 'balance:1:' || p_wallet || ':' || p_account || ':';
    IF left(v_payload,length(v_prefix)) <> v_prefix THEN RAISE EXCEPTION 'key context mismatch'; END IF;
    public_key := v_key.public_key; secret := v_key.secret;
    balance_key := decode(substr(v_payload,length(v_prefix)+1),'base64');
    IF octet_length(balance_key) <> 16 THEN RAISE EXCEPTION 'invalid balance key'; END IF;
    RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING MESSAGE='account keys could not be read', ERRCODE='P0001';
END;
$$;
REVOKE ALL ON FUNCTION cadence_private.account_key_metadata(text,text),
    cadence_private.store_account_keys(text,text,bytea,text,text),
    cadence_private.read_account_keys(text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cadence_private.account_key_metadata(text,text),
    cadence_private.store_account_keys(text,text,bytea,text,text),
    cadence_private.read_account_keys(text,text,text) TO cadence_key_service;

CREATE TABLE public.account_requests (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    wallet text NOT NULL,
    token_account text NOT NULL REFERENCES public.proof_accounts(token_account),
    kind text NOT NULL CHECK (kind IN ('configure','apply_pending')),
    transaction text NOT NULL CHECK (length(transaction) BETWEEN 1 AND 5464),
    last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height>=0),
    expected_counter bigint CHECK (expected_counter>=0),
    signature text UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    submitted_signature text UNIQUE CHECK (submitted_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    slot bigint CHECK (slot>=0),
    status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','finalized','failed')),
    FOREIGN KEY (wallet,user_id) REFERENCES public.proof_wallets(wallet,user_id),
    CHECK ((signature IS NULL) = (slot IS NULL)),
    CHECK ((status='prepared') = (signature IS NULL))
);
ALTER TABLE public.account_requests ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX one_prepared_account_update ON public.account_requests(user_id,kind) WHERE status='prepared';
REVOKE ALL ON public.account_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.account_requests TO cadence_transfer_service;
GRANT UPDATE (signature,submitted_signature,slot,status) ON public.account_requests TO cadence_transfer_service;
CREATE POLICY account_requests_service ON public.account_requests TO cadence_transfer_service USING (true) WITH CHECK (true);
CREATE FUNCTION public.guard_account_request() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF OLD.status <> 'prepared' OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
        OR NEW.wallet<>OLD.wallet OR NEW.token_account<>OLD.token_account OR NEW.kind<>OLD.kind
        OR NEW.transaction<>OLD.transaction OR NEW.last_valid_block_height<>OLD.last_valid_block_height
        OR NEW.expected_counter IS DISTINCT FROM OLD.expected_counter
        OR (OLD.submitted_signature IS NOT NULL AND NEW.submitted_signature IS DISTINCT FROM OLD.submitted_signature)
        OR (NEW.status<>'prepared' AND NEW.signature IS DISTINCT FROM NEW.submitted_signature) THEN
        RAISE EXCEPTION 'account request is immutable';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_account_request() FROM PUBLIC;
CREATE TRIGGER guard_account_request BEFORE UPDATE ON public.account_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_account_request();
