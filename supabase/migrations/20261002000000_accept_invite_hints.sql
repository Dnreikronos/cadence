-- Give each accept_invite failure a stable hint the web app maps to a message (#76).
-- Messages and SQLSTATE are unchanged; only the hint is added.
CREATE OR REPLACE FUNCTION public.accept_invite(p_token text) RETURNS public.membership_role
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
        RAISE EXCEPTION 'invite not found' USING HINT = 'invite_not_found';
    END IF;
    IF v_invite.accepted_at IS NOT NULL THEN
        RAISE EXCEPTION 'invite already accepted' USING HINT = 'invite_already_accepted';
    END IF;
    IF v_invite.expires_at <= now() THEN
        RAISE EXCEPTION 'invite expired' USING HINT = 'invite_expired';
    END IF;
    IF EXISTS (SELECT 1 FROM public.memberships WHERE user_id = v_user) THEN
        RAISE EXCEPTION 'already a member of a company' USING HINT = 'invite_already_member';
    END IF;
    -- An unconfirmed address proves nothing about who owns it.
    SELECT u.email INTO v_email FROM auth.users AS u
        WHERE u.id = v_user AND u.email_confirmed_at IS NOT NULL;
    IF v_email IS NULL THEN
        RAISE EXCEPTION 'email not confirmed' USING HINT = 'invite_email_unconfirmed';
    END IF;

    IF v_invite.role = 'recipient' THEN
        SELECT * INTO STRICT v_person FROM public.people WHERE id = v_invite.person_id FOR UPDATE;
        IF v_person.status = 'removed' THEN
            RAISE EXCEPTION 'person was removed' USING HINT = 'invite_person_removed';
        END IF;
        -- An admin may change a linked person's email; that must not hand the row to someone else.
        IF v_person.user_id IS NOT NULL THEN
            RAISE EXCEPTION 'person already linked' USING HINT = 'invite_person_linked';
        END IF;
        IF lower(v_person.email) <> lower(v_email) THEN
            RAISE EXCEPTION 'invite is for another email' USING HINT = 'invite_wrong_email';
        END IF;
        UPDATE public.people SET user_id = v_user WHERE id = v_person.id;
    ELSIF lower(v_invite.email) <> lower(v_email) THEN
        RAISE EXCEPTION 'invite is for another email' USING HINT = 'invite_wrong_email';
    END IF;

    INSERT INTO public.memberships (user_id, company_id, role)
        VALUES (v_user, v_invite.company_id, v_invite.role);
    UPDATE public.invites SET accepted_at = now() WHERE id = v_invite.id;
    RETURN v_invite.role;
END;
$$;
