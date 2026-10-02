-- create_company and accept_invite are the only ways to gain a membership.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(38);

CREATE FUNCTION pg_temp.login(uid uuid) RETURNS void LANGUAGE sql AS $$
    SELECT set_config('request.jwt.claims',
        json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('00000000-0000-0000-0000-0000000000a1', 'admin@a.test', now()),
    ('00000000-0000-0000-0000-0000000000b1', 'admin@b.test', now()),
    ('00000000-0000-0000-0000-0000000000f1', 'founder@x.test', now()),
    ('00000000-0000-0000-0000-0000000000c1', 'recipient@a.test', now()),
    ('00000000-0000-0000-0000-0000000000c2', 'other@x.test', now()),
    ('00000000-0000-0000-0000-0000000000c3', 'late@a.test', now()),
    ('00000000-0000-0000-0000-0000000000c4', 'gone@a.test', now()),
    ('00000000-0000-0000-0000-0000000000c5', 'typo@a.test', now()),
    ('00000000-0000-0000-0000-0000000000c6', 'fixed@a.test', now()),
    ('00000000-0000-0000-0000-0000000000d1', 'auditor@x.test', now()),
    ('00000000-0000-0000-0000-0000000000d2', 'old@x.test', now());
INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-0000000000d3', 'unconfirmed@x.test');
INSERT INTO public.companies (id, name) VALUES
    ('00000000-0000-0000-0000-00000000000a', 'Company A'),
    ('00000000-0000-0000-0000-00000000000b', 'Company B');
INSERT INTO public.memberships (user_id, company_id, role) VALUES
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'admin'),
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'admin');
INSERT INTO public.people (id, company_id, name, email, kind, status) VALUES
    ('00000000-0000-0000-0001-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'Recipient', 'Recipient@A.test', 'employee', 'pending'),
    ('00000000-0000-0000-0001-0000000000c3', '00000000-0000-0000-0000-00000000000a', 'Late', 'late@a.test', 'employee', 'pending'),
    ('00000000-0000-0000-0001-0000000000c4', '00000000-0000-0000-0000-00000000000a', 'Gone', 'gone@a.test', 'employee', 'removed'),
    ('00000000-0000-0000-0001-0000000000c5', '00000000-0000-0000-0000-00000000000a', 'Typo', 'typo@a.test', 'employee', 'pending'),
    ('00000000-0000-0000-0001-0000000000b9', '00000000-0000-0000-0000-00000000000b', 'Other B', 'other@b.test', 'employee', 'pending');
INSERT INTO public.invites (id, company_id, role, person_id, email, token_hash, expires_at, accepted_at) VALUES
    ('00000000-0000-0000-0002-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'recipient',
        '00000000-0000-0000-0001-0000000000c1', NULL, sha256('tok-recipient'), DEFAULT, NULL),
    ('00000000-0000-0000-0002-0000000000c3', '00000000-0000-0000-0000-00000000000a', 'recipient',
        '00000000-0000-0000-0001-0000000000c3', NULL, sha256('tok-late'), now() - interval '1 minute', NULL),
    ('00000000-0000-0000-0002-0000000000c4', '00000000-0000-0000-0000-00000000000a', 'recipient',
        '00000000-0000-0000-0001-0000000000c4', NULL, sha256('tok-gone'), DEFAULT, NULL),
    ('00000000-0000-0000-0002-0000000000c5', '00000000-0000-0000-0000-00000000000a', 'recipient',
        '00000000-0000-0000-0001-0000000000c5', NULL, sha256('tok-typo'), DEFAULT, NULL),
    ('00000000-0000-0000-0002-0000000000d1', '00000000-0000-0000-0000-00000000000a', 'auditor',
        NULL, 'Auditor@X.test', sha256('tok-auditor'), DEFAULT, NULL),
    ('00000000-0000-0000-0002-0000000000d2', '00000000-0000-0000-0000-00000000000a', 'auditor',
        NULL, 'old@x.test', sha256('tok-old'), DEFAULT, now()),
    ('00000000-0000-0000-0002-0000000000d3', '00000000-0000-0000-0000-00000000000a', 'auditor',
        NULL, 'unconfirmed@x.test', sha256('tok-unconfirmed'), DEFAULT, NULL),
    ('00000000-0000-0000-0002-0000000000b1', '00000000-0000-0000-0000-00000000000a', 'auditor',
        NULL, 'admin@b.test', sha256('tok-admin-b'), DEFAULT, NULL),
    ('00000000-0000-0000-0002-0000000000e1', '00000000-0000-0000-0000-00000000000a', 'auditor',
        NULL, 'revoke-me@x.test', sha256('tok-revoke'), DEFAULT, NULL);

SELECT is((SELECT expires_at FROM public.invites WHERE id = '00000000-0000-0000-0002-0000000000c1'),
    now() + interval '7 days', 'invites expire after 7 days by default');

-- Invite shape
SELECT throws_ok($$INSERT INTO public.invites (company_id, role, email, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'admin', 'boss@x.test', sha256('x1'))$$,
    '23514', NULL, 'admin invites are not allowed');
SELECT throws_ok($$INSERT INTO public.invites (company_id, role, person_id, email, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'recipient', '00000000-0000-0000-0001-0000000000c1', 'x@x.test', sha256('x2'))$$,
    '23514', NULL, 'recipient invites carry no email');
SELECT throws_ok($$INSERT INTO public.invites (company_id, role, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'recipient', sha256('x3'))$$,
    '23514', NULL, 'recipient invites need a person');
SELECT throws_ok($$INSERT INTO public.invites (company_id, role, person_id, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'auditor', '00000000-0000-0000-0001-0000000000c1', sha256('x4'))$$,
    '23514', NULL, 'auditor invites need an email and no person');
SELECT throws_ok($$INSERT INTO public.invites (company_id, role, person_id, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'recipient', '00000000-0000-0000-0001-0000000000b9', sha256('x5'))$$,
    '23503', NULL, 'recipient invites stay inside the person''s company');
SELECT throws_ok($$INSERT INTO public.invites (company_id, role, person_id, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'recipient', '00000000-0000-0000-0001-0000000000c1', sha256('x6'))$$,
    '23505', NULL, 'one pending invite per person');
SELECT throws_ok($$INSERT INTO public.invites (company_id, role, email, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'auditor', 'AUDITOR@x.test', sha256('x7'))$$,
    '23505', NULL, 'one pending invite per company and email');
SELECT lives_ok($$INSERT INTO public.invites (company_id, role, email, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'auditor', 'old@x.test', sha256('x8'))$$,
    'an accepted invite does not block a new one');
SELECT throws_ok($$INSERT INTO public.invites (company_id, role, email, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'auditor', 'dup@x.test', sha256('tok-auditor'))$$,
    '23505', NULL, 'token hashes are unique');

-- create_company
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000f1');
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.create_company('Founder Co')$$, 'a user without a membership creates a company');
SELECT results_eq('SELECT c.name, m.role::text FROM public.companies c JOIN public.memberships m ON m.company_id = c.id',
    $$VALUES ('Founder Co', 'admin')$$, 'the creator becomes its admin');
SELECT throws_ok($$SELECT public.create_company('Second Co')$$, 'P0001', 'already a member of a company',
    'a member cannot create a second company');
RESET ROLE;
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c2');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.create_company('   ')$$, '23514', NULL, 'company names cannot be blank');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.create_company('Ghost Co')$$, 'P0001', 'not signed in',
    'create_company requires a user');
RESET ROLE;

-- accept_invite: recipient
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c2');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('no-such-token')$$, 'P0001', 'invite not found', 'unknown tokens fail');
SELECT throws_ok($$SELECT public.accept_invite('tok-recipient')$$, 'P0001', 'invite is for another email',
    'a recipient invite needs the person''s email');
RESET ROLE;
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c1');
SET LOCAL ROLE authenticated;
SELECT is(public.accept_invite('tok-recipient'), 'recipient'::public.membership_role,
    'a recipient accepts with a case-insensitive email match');
SELECT results_eq('SELECT company_id, role::text FROM public.memberships',
    $$VALUES ('00000000-0000-0000-0000-00000000000a'::uuid, 'recipient')$$, 'accepting creates the membership');
SELECT results_eq('SELECT id FROM public.people',
    $$VALUES ('00000000-0000-0000-0001-0000000000c1'::uuid)$$, 'accepting links the person to the user');
SELECT throws_ok($$SELECT public.accept_invite('tok-recipient')$$, 'P0001', 'invite already accepted',
    'an invite is accepted once');
RESET ROLE;
SELECT isnt((SELECT accepted_at FROM public.invites WHERE id = '00000000-0000-0000-0002-0000000000c1'),
    NULL, 'accepting stamps accepted_at');

-- Re-inviting a linked person under a new email must not hand their row to another user.
UPDATE public.people SET email = 'other@x.test' WHERE id = '00000000-0000-0000-0001-0000000000c1';
INSERT INTO public.invites (company_id, role, person_id, token_hash) VALUES
    ('00000000-0000-0000-0000-00000000000a', 'recipient', '00000000-0000-0000-0001-0000000000c1', sha256('tok-relink'));
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c2');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('tok-relink')$$, 'P0001', 'person already linked',
    'a linked person cannot be claimed by another user');
RESET ROLE;

SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c3');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('tok-late')$$, 'P0001', 'invite expired', 'expired invites fail');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT lives_ok($$UPDATE public.invites SET token_hash = sha256('tok-late-resent'), expires_at = now() + interval '7 days'
    WHERE id = '00000000-0000-0000-0002-0000000000c3'$$, 'service_role resends the expired invite');
RESET ROLE;
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c3');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('tok-late')$$, 'P0001', 'invite not found', 'a resend retires the old token');
SELECT is(public.accept_invite('tok-late-resent'), 'recipient'::public.membership_role, 'the resent token works');
RESET ROLE;

SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c4');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('tok-gone')$$, 'P0001', 'person was removed', 'removed people cannot accept');
RESET ROLE;

-- The admin corrects a typo after the invite went out; the current email wins.
UPDATE public.people SET email = 'fixed@a.test' WHERE id = '00000000-0000-0000-0001-0000000000c5';
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c5');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('tok-typo')$$, 'P0001', 'invite is for another email',
    'the old email no longer accepts');
RESET ROLE;
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c6');
SET LOCAL ROLE authenticated;
SELECT is(public.accept_invite('tok-typo'), 'recipient'::public.membership_role, 'the corrected email accepts');
RESET ROLE;

-- accept_invite: auditor
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c2');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('tok-auditor')$$, 'P0001', 'invite is for another email',
    'an auditor invite needs the invited email');
RESET ROLE;
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000d1');
SET LOCAL ROLE authenticated;
SELECT is(public.accept_invite('tok-auditor'), 'auditor'::public.membership_role, 'an auditor accepts');
SELECT results_eq('SELECT company_id, role::text FROM public.memberships',
    $$VALUES ('00000000-0000-0000-0000-00000000000a'::uuid, 'auditor')$$, 'the auditor joins the inviting company');
RESET ROLE;
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000d2');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('tok-old')$$, 'P0001', 'invite already accepted',
    'an accepted auditor invite cannot be reused');
RESET ROLE;
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000d3');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('tok-unconfirmed')$$, 'P0001', 'email not confirmed',
    'an unconfirmed email cannot accept');
RESET ROLE;
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000b1');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.accept_invite('tok-admin-b')$$, 'P0001', 'already a member of a company',
    'a member of another company cannot accept');
RESET ROLE;

-- Admin deletes a pending auditor invite, but not an accepted one.
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a1');
SET LOCAL ROLE authenticated;
SELECT results_eq($$DELETE FROM public.invites WHERE id = '00000000-0000-0000-0002-0000000000e1' RETURNING id$$,
    $$VALUES ('00000000-0000-0000-0002-0000000000e1'::uuid)$$, 'admin deletes a pending auditor invite');
SELECT is_empty($$DELETE FROM public.invites WHERE id = '00000000-0000-0000-0002-0000000000d1' RETURNING id$$,
    'admin cannot delete an accepted auditor invite');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
