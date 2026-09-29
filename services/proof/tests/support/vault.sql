-- Disposable Supabase image fixture only. Run as supabase_admin, never in production.
-- Match hosted permissions for the database's normal postgres administrator.
ALTER DATABASE keys_test OWNER TO postgres;
GRANT ALL ON SCHEMA public TO postgres;

-- Catch plaintext at the heap boundary, before it can enter heap pages or WAL.
-- Empty placeholders are harmless; every nonempty write must authenticate as
-- real Vault ciphertext, including intermediate writes inside Vault functions.
CREATE FUNCTION public.require_vault_ciphertext() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.secret <> '' THEN
        PERFORM vault._crypto_aead_det_decrypt(
            decode(NEW.secret, 'base64'), convert_to(NEW.id::text, 'utf8'),
            0, 'pgsodium'::bytea, NEW.nonce);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER require_vault_ciphertext BEFORE INSERT OR UPDATE ON vault.secrets
    FOR EACH ROW EXECUTE FUNCTION public.require_vault_ciphertext();
