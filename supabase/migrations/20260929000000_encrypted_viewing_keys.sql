-- Apply as Supabase postgres (migration administrator). Vault 0.3.1 is tested.
CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;
DO $$ BEGIN
    IF (SELECT extversion FROM pg_extension WHERE extname = 'supabase_vault') <> '0.3.1' THEN
        RAISE EXCEPTION 'Review Vault encryption primitives before upgrading';
    END IF;
END $$;

-- Configure LOGIN/password through deployment secret management, never this file.
CREATE ROLE cadence_key_service NOLOGIN NOINHERIT;
ALTER ROLE cadence_key_service SET log_parameter_max_length_on_error = 0;
CREATE SCHEMA cadence_private;
REVOKE ALL ON SCHEMA cadence_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA cadence_private TO cadence_key_service;

CREATE TABLE cadence_private.viewing_keys (
    token_account text PRIMARY KEY CHECK (token_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    wallet text NOT NULL CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
    secret_id uuid NOT NULL UNIQUE REFERENCES vault.secrets(id),
    format_version smallint NOT NULL DEFAULT 1 CHECK (format_version = 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cadence_private.key_read_permits (
    id uuid PRIMARY KEY REFERENCES public.decryption_audit_log(id),
    token_account text NOT NULL,
    issued_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
ALTER TABLE cadence_private.viewing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE cadence_private.key_read_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA cadence_private FROM PUBLIC, anon, authenticated, service_role, cadence_key_service;
-- Supabase owns Vault. Do not require superuser-only changes to its extension.
-- Its broad service_role remains privileged; the proof runtime uses our own role.
DO $$ BEGIN
    IF has_schema_privilege('cadence_key_service', 'vault', 'USAGE') THEN
        RAISE EXCEPTION 'Runtime role must not have direct Vault access';
    END IF;
END $$;

CREATE FUNCTION cadence_private.store_viewing_key(
    p_wallet text, p_account text, p_public bytea, p_secret text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF octet_length(decode(p_secret, 'base64')) <> 32 OR octet_length(p_public) <> 32 THEN
        RAISE EXCEPTION 'invalid key';
    END IF;
    -- create_secret inserts its argument before encrypting: give it NO secret.
    -- update_secret encrypts the real payload before UPDATE. This keeps viewing
    -- keys out of heap/WAL without calling Supabase's restricted primitives.
    v_id := vault.create_secret('');
    PERFORM vault.update_secret(v_id,
        '1:' || p_wallet || ':' || p_account || ':' || encode(p_public, 'hex') || ':' || p_secret);
    INSERT INTO cadence_private.viewing_keys (token_account, wallet, public_key, secret_id)
        VALUES (p_account, p_wallet, p_public, v_id);
EXCEPTION WHEN OTHERS THEN
    -- Never propagate constraint detail, input values, or a Vault error context.
    RAISE EXCEPTION USING MESSAGE = 'viewing key could not be stored', ERRCODE = 'P0001';
END;
$$;

CREATE FUNCTION cadence_private.audit_key_read(p_actor text, p_reason text, p_account text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_id uuid;
BEGIN
    INSERT INTO public.decryption_audit_log (actor, reason, target_account)
        VALUES (p_actor, p_reason, p_account) RETURNING id INTO v_id;
    INSERT INTO cadence_private.key_read_permits (id, token_account) VALUES (v_id, p_account);
    RETURN v_id::text;
EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING MESSAGE = 'key access could not be audited', ERRCODE = 'P0001';
END;
$$;

CREATE FUNCTION cadence_private.read_viewing_key(p_wallet text, p_account text, p_permit text)
RETURNS TABLE (public_key bytea, secret bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_key cadence_private.viewing_keys;
    v_payload text;
    v_prefix text;
BEGIN
    -- Explicitly exclude our own top-level transaction: snapshots omit its ID
    -- from their in-progress set. Auditing must commit before decryption.
    DELETE FROM cadence_private.key_read_permits AS permit
        WHERE permit.id = p_permit::uuid AND permit.token_account = p_account
        AND permit.issued_xid <> pg_current_xact_id()
        AND pg_visible_in_snapshot(permit.issued_xid, pg_current_snapshot());
    IF NOT FOUND THEN
        RAISE EXCEPTION 'committed matching audit permit required';
    END IF;
    SELECT * INTO STRICT v_key FROM cadence_private.viewing_keys
        WHERE wallet = p_wallet AND token_account = p_account;
    SELECT decrypted_secret INTO STRICT v_payload FROM vault.decrypted_secrets
        WHERE id = v_key.secret_id;
    v_prefix := v_key.format_version::text || ':' || p_wallet || ':' || p_account || ':' || encode(v_key.public_key, 'hex') || ':';
    IF left(v_payload, length(v_prefix)) <> v_prefix THEN
        RAISE EXCEPTION 'key context mismatch';
    END IF;
    public_key := v_key.public_key;
    secret := decode(substr(v_payload, length(v_prefix) + 1), 'base64');
    IF octet_length(secret) <> 32 THEN
        RAISE EXCEPTION 'invalid key';
    END IF;
    RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING MESSAGE = 'viewing key could not be read', ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cadence_private FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cadence_private.store_viewing_key(text, text, bytea, text),
    cadence_private.audit_key_read(text, text, text),
    cadence_private.read_viewing_key(text, text, text) TO cadence_key_service;
