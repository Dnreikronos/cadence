-- Companies, memberships, people and invites (#75). RLS is the authorization
-- boundary (B13): the browser reads these tables directly. No amounts (B12).
CREATE TYPE public.membership_role AS ENUM ('admin', 'recipient', 'auditor');
CREATE TYPE public.person_kind AS ENUM ('employee', 'contractor', 'supplier');
CREATE TYPE public.person_status AS ENUM ('pending', 'active', 'removed');

CREATE TABLE public.companies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (name ~ '[^[:space:]]' AND length(name) <= 200),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One user, one role, one company (#74): the primary key is user_id.
CREATE TABLE public.memberships (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES public.companies(id),
    role public.membership_role NOT NULL
);
CREATE UNIQUE INDEX memberships_one_admin_per_company ON public.memberships (company_id)
    WHERE role = 'admin';

-- Who gets paid. Amounts live on-chain, encrypted, never here.
CREATE TABLE public.people (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id),
    name text NOT NULL CHECK (name ~ '[^[:space:]]' AND length(name) <= 200),
    email text NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND length(email) <= 320),
    kind public.person_kind NOT NULL,
    status public.person_status NOT NULL DEFAULT 'pending',
    user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
    UNIQUE (id, company_id)
);
CREATE UNIQUE INDEX people_company_email ON public.people (company_id, lower(email));

-- Recipient invites follow the person's current email; auditor invites carry their own.
CREATE TABLE public.invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id),
    role public.membership_role NOT NULL,
    person_id uuid,
    email text CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND length(email) <= 320),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (person_id, company_id) REFERENCES public.people(id, company_id) ON DELETE CASCADE,
    CHECK (
        (role = 'recipient' AND person_id IS NOT NULL AND email IS NULL) OR
        (role = 'auditor' AND email IS NOT NULL AND person_id IS NULL)
    )
);
CREATE UNIQUE INDEX invites_pending_person ON public.invites (person_id)
    WHERE accepted_at IS NULL;
CREATE UNIQUE INDEX invites_pending_email ON public.invites (company_id, lower(email))
    WHERE accepted_at IS NULL;

-- The invite service only activates pending people; admins only remove.
-- Removal is final.
CREATE FUNCTION public.guard_person_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    IF current_user = 'service_role' THEN
        IF OLD.status = 'pending' AND NEW.status = 'active' THEN
            RETURN NEW;
        END IF;
    ELSIF NEW.status = 'removed' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'person status cannot change from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_person_status() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER person_status_transitions BEFORE UPDATE OF status ON public.people
    FOR EACH ROW EXECUTE FUNCTION public.guard_person_status();

-- RLS helpers. A separate schema keeps authenticated's USAGE away from
-- cadence_private's key accessors. SECURITY DEFINER avoids policy recursion on memberships.
CREATE SCHEMA cadence_rls;
REVOKE ALL ON SCHEMA cadence_rls FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA cadence_rls TO authenticated;

-- Relies on its owner owning memberships: never FORCE ROW LEVEL SECURITY there.
CREATE FUNCTION cadence_rls.current_membership()
RETURNS TABLE (company_id uuid, role public.membership_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT m.company_id, m.role FROM public.memberships AS m WHERE m.user_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION cadence_rls.current_membership() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cadence_rls.current_membership() TO authenticated;

-- RLS does not constrain Supabase's BYPASSRLS service role; privileges do.
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.companies, public.memberships, public.people, public.invites
    FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON public.companies, public.memberships, public.people TO authenticated;
GRANT INSERT (company_id, name, email, kind) ON public.people TO authenticated;
GRANT UPDATE (name, email, kind, status) ON public.people TO authenticated;
-- Never token_hash: clients must name invite columns rather than select *.
GRANT SELECT (id, company_id, role, person_id, email, expires_at, accepted_at, created_at)
    ON public.invites TO authenticated;
GRANT DELETE ON public.invites TO authenticated;

-- The invite sender (#80): create and resend invites, activate people.
GRANT SELECT ON public.people, public.invites TO service_role;
GRANT UPDATE (status) ON public.people TO service_role;
GRANT INSERT (company_id, role, person_id, email, token_hash, expires_at) ON public.invites TO service_role;
GRANT UPDATE (token_hash, expires_at) ON public.invites TO service_role;

CREATE POLICY member_read ON public.companies FOR SELECT TO authenticated
    USING (id IN (SELECT company_id FROM cadence_rls.current_membership()));

-- The middleware reads the caller's own role.
CREATE POLICY own_or_admin_read ON public.memberships FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid())
        OR company_id IN (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin'));

-- Recipients see only themselves, including after removal.
CREATE POLICY self_or_staff_read ON public.people FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid())
        OR company_id IN (SELECT company_id FROM cadence_rls.current_membership()
                          WHERE role IN ('admin', 'auditor')));
CREATE POLICY admin_insert ON public.people FOR INSERT TO authenticated
    WITH CHECK (company_id IN (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin'));
CREATE POLICY admin_update ON public.people FOR UPDATE TO authenticated
    USING (company_id IN (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin'))
    WITH CHECK (company_id IN (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin'));

CREATE POLICY admin_read ON public.invites FOR SELECT TO authenticated
    USING (company_id IN (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin'));
CREATE POLICY admin_withdraw_auditor ON public.invites FOR DELETE TO authenticated
    USING (role = 'auditor' AND accepted_at IS NULL
        AND company_id IN (SELECT company_id FROM cadence_rls.current_membership() WHERE role = 'admin'));

CREATE FUNCTION public.create_company(p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_user uuid := auth.uid();
    v_company uuid;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'not signed in';
    END IF;
    IF EXISTS (SELECT 1 FROM public.memberships WHERE user_id = v_user) THEN
        RAISE EXCEPTION 'already a member of a company';
    END IF;
    INSERT INTO public.companies (name) VALUES (p_name) RETURNING id INTO v_company;
    INSERT INTO public.memberships (user_id, company_id, role) VALUES (v_user, v_company, 'admin');
    RETURN v_company;
END;
$$;

-- Tokens are random and single-use; only their SHA-256 is stored.
CREATE FUNCTION public.accept_invite(p_token text) RETURNS public.membership_role
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_user uuid := auth.uid();
    v_email text;
    v_invite public.invites;
    v_person public.people;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'not signed in';
    END IF;
    SELECT * INTO v_invite FROM public.invites
        WHERE token_hash = sha256(convert_to(p_token, 'UTF8')) FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'invite not found';
    END IF;
    IF v_invite.accepted_at IS NOT NULL THEN
        RAISE EXCEPTION 'invite already accepted';
    END IF;
    IF v_invite.expires_at <= now() THEN
        RAISE EXCEPTION 'invite expired';
    END IF;
    IF EXISTS (SELECT 1 FROM public.memberships WHERE user_id = v_user) THEN
        RAISE EXCEPTION 'already a member of a company';
    END IF;
    -- An unconfirmed address proves nothing about who owns it.
    SELECT u.email INTO v_email FROM auth.users AS u
        WHERE u.id = v_user AND u.email_confirmed_at IS NOT NULL;
    IF v_email IS NULL THEN
        RAISE EXCEPTION 'email not confirmed';
    END IF;

    IF v_invite.role = 'recipient' THEN
        SELECT * INTO STRICT v_person FROM public.people WHERE id = v_invite.person_id FOR UPDATE;
        IF v_person.status = 'removed' THEN
            RAISE EXCEPTION 'person was removed';
        END IF;
        -- An admin may change a linked person's email; that must not hand the row to someone else.
        IF v_person.user_id IS NOT NULL THEN
            RAISE EXCEPTION 'person already linked';
        END IF;
        IF lower(v_person.email) <> lower(v_email) THEN
            RAISE EXCEPTION 'invite is for another email';
        END IF;
        UPDATE public.people SET user_id = v_user WHERE id = v_person.id;
    ELSIF lower(v_invite.email) <> lower(v_email) THEN
        RAISE EXCEPTION 'invite is for another email';
    END IF;

    INSERT INTO public.memberships (user_id, company_id, role)
        VALUES (v_user, v_invite.company_id, v_invite.role);
    UPDATE public.invites SET accepted_at = now() WHERE id = v_invite.id;
    RETURN v_invite.role;
END;
$$;

REVOKE ALL ON FUNCTION public.create_company(text), public.accept_invite(text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_company(text), public.accept_invite(text) TO authenticated;
