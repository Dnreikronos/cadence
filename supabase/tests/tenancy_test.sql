-- RLS and privileges are the authorization boundary (B13): prove every
-- table x every role sees only its own company, and forbidden writes fail.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(65);

CREATE FUNCTION pg_temp.login(uid uuid) RETURNS void LANGUAGE sql AS $$
    SELECT set_config('request.jwt.claims',
        json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;

-- Company A and B each have an admin, a recipient and an auditor.
-- a9 is signed in but belongs to no company.
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('00000000-0000-0000-0000-0000000000a1', 'admin@a.test', now()),
    ('00000000-0000-0000-0000-0000000000a2', 'recipient@a.test', now()),
    ('00000000-0000-0000-0000-0000000000a3', 'auditor@a.test', now()),
    ('00000000-0000-0000-0000-0000000000a9', 'outsider@a.test', now()),
    ('00000000-0000-0000-0000-0000000000b1', 'admin@b.test', now()),
    ('00000000-0000-0000-0000-0000000000b2', 'recipient@b.test', now()),
    ('00000000-0000-0000-0000-0000000000b3', 'auditor@b.test', now());
INSERT INTO public.companies (id, name) VALUES
    ('00000000-0000-0000-0000-00000000000a', 'Company A'),
    ('00000000-0000-0000-0000-00000000000b', 'Company B');
INSERT INTO public.memberships (user_id, company_id, role) VALUES
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'admin'),
    ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'recipient'),
    ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000000a', 'auditor'),
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'admin'),
    ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000b', 'recipient'),
    ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000000b', 'auditor');
INSERT INTO public.people (id, company_id, name, email, kind, status, user_id) VALUES
    ('00000000-0000-0000-0001-0000000000a2', '00000000-0000-0000-0000-00000000000a',
        'Recipient A', 'recipient@a.test', 'employee', 'active', '00000000-0000-0000-0000-0000000000a2'),
    ('00000000-0000-0000-0001-0000000000a4', '00000000-0000-0000-0000-00000000000a',
        'Pending A', 'pending@a.test', 'contractor', 'pending', NULL),
    ('00000000-0000-0000-0001-0000000000a5', '00000000-0000-0000-0000-00000000000a',
        'Activating A', 'activating@a.test', 'supplier', 'pending', NULL),
    ('00000000-0000-0000-0001-0000000000b2', '00000000-0000-0000-0000-00000000000b',
        'Recipient B', 'recipient@b.test', 'employee', 'active', '00000000-0000-0000-0000-0000000000b2');
INSERT INTO public.invites (id, company_id, role, person_id, email, token_hash) VALUES
    ('00000000-0000-0000-0002-0000000000a3', '00000000-0000-0000-0000-00000000000a',
        'auditor', NULL, 'next-auditor@a.test', sha256('token-a3')),
    ('00000000-0000-0000-0002-0000000000a4', '00000000-0000-0000-0000-00000000000a',
        'recipient', '00000000-0000-0000-0001-0000000000a4', NULL, sha256('token-a4')),
    ('00000000-0000-0000-0002-0000000000b3', '00000000-0000-0000-0000-00000000000b',
        'auditor', NULL, 'next-auditor@b.test', sha256('token-b3'));

-- Reads: admin A
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a1');
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT id FROM public.companies',
    $$VALUES ('00000000-0000-0000-0000-00000000000a'::uuid)$$, 'admin reads only own company');
SELECT results_eq('SELECT user_id FROM public.memberships ORDER BY user_id',
    $$VALUES ('00000000-0000-0000-0000-0000000000a1'::uuid), ('00000000-0000-0000-0000-0000000000a2'),
             ('00000000-0000-0000-0000-0000000000a3')$$, 'admin reads all memberships of own company');
SELECT results_eq('SELECT id FROM public.people ORDER BY id',
    $$VALUES ('00000000-0000-0000-0001-0000000000a2'::uuid), ('00000000-0000-0000-0001-0000000000a4'),
             ('00000000-0000-0000-0001-0000000000a5')$$, 'admin reads all people of own company');
SELECT results_eq('SELECT id FROM public.invites ORDER BY id',
    $$VALUES ('00000000-0000-0000-0002-0000000000a3'::uuid), ('00000000-0000-0000-0002-0000000000a4')$$,
    'admin reads invites of own company');
SELECT throws_ok('SELECT token_hash FROM public.invites', '42501', NULL, 'admin cannot read token hashes');
RESET ROLE;

-- Reads: recipient A
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a2');
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT id FROM public.companies',
    $$VALUES ('00000000-0000-0000-0000-00000000000a'::uuid)$$, 'recipient reads only own company');
SELECT results_eq($$SELECT role::text FROM public.memberships WHERE user_id = '00000000-0000-0000-0000-0000000000a2'$$,
    $$VALUES ('recipient')$$, 'middleware query returns the role under RLS');
SELECT results_eq('SELECT user_id FROM public.memberships',
    $$VALUES ('00000000-0000-0000-0000-0000000000a2'::uuid)$$, 'recipient reads only own membership');
SELECT results_eq('SELECT id FROM public.people',
    $$VALUES ('00000000-0000-0000-0001-0000000000a2'::uuid)$$, 'recipient reads only own person row');
SELECT is_empty('SELECT id FROM public.invites', 'recipient reads no invites');
RESET ROLE;

-- Reads: auditor A
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a3');
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT id FROM public.companies',
    $$VALUES ('00000000-0000-0000-0000-00000000000a'::uuid)$$, 'auditor reads only own company');
SELECT results_eq('SELECT user_id FROM public.memberships',
    $$VALUES ('00000000-0000-0000-0000-0000000000a3'::uuid)$$, 'auditor reads only own membership');
SELECT results_eq('SELECT id FROM public.people ORDER BY id',
    $$VALUES ('00000000-0000-0000-0001-0000000000a2'::uuid), ('00000000-0000-0000-0001-0000000000a4'),
             ('00000000-0000-0000-0001-0000000000a5')$$, 'auditor reads all people of own company');
SELECT is_empty('SELECT id FROM public.invites', 'auditor reads no invites');
RESET ROLE;

-- Reads: admin B sees only B (the fixtures are not one-sided)
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000b1');
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT id FROM public.people',
    $$VALUES ('00000000-0000-0000-0001-0000000000b2'::uuid)$$, 'admin B reads only company B people');
SELECT results_eq('SELECT id FROM public.invites',
    $$VALUES ('00000000-0000-0000-0002-0000000000b3'::uuid)$$, 'admin B reads only company B invites');
RESET ROLE;

-- Reads: signed in without a membership
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a9');
SET LOCAL ROLE authenticated;
SELECT is_empty('SELECT id FROM public.companies', 'outsider reads no companies');
SELECT is_empty('SELECT user_id FROM public.memberships', 'outsider reads no memberships');
SELECT is_empty('SELECT id FROM public.people', 'outsider reads no people');
SELECT is_empty('SELECT id FROM public.invites', 'outsider reads no invites');
RESET ROLE;

-- Reads: anon
SET LOCAL ROLE anon;
SELECT throws_ok('SELECT 1 FROM public.companies', '42501', NULL, 'anon cannot read companies');
SELECT throws_ok('SELECT 1 FROM public.memberships', '42501', NULL, 'anon cannot read memberships');
SELECT throws_ok('SELECT 1 FROM public.people', '42501', NULL, 'anon cannot read people');
SELECT throws_ok('SELECT 1 FROM public.invites', '42501', NULL, 'anon cannot read invites');
SELECT throws_ok($$SELECT public.create_company('Anon Co')$$, '42501', NULL, 'anon cannot create a company');
SELECT throws_ok($$SELECT public.accept_invite('token-a3')$$, '42501', NULL, 'anon cannot accept an invite');
RESET ROLE;

-- Writes: service_role (invite sender and activation, #80)
SET LOCAL ROLE service_role;
SELECT lives_ok($$UPDATE public.people SET status = 'active' WHERE id = '00000000-0000-0000-0001-0000000000a5'$$,
    'service_role activates a pending person');
SELECT throws_ok($$UPDATE public.people SET status = 'pending' WHERE id = '00000000-0000-0000-0001-0000000000a5'$$,
    '23514', NULL, 'service_role cannot move an active person back to pending');
SELECT throws_ok($$UPDATE public.people SET status = 'removed' WHERE id = '00000000-0000-0000-0001-0000000000a5'$$,
    '23514', NULL, 'service_role cannot remove a person');
SELECT throws_ok($$UPDATE public.people SET user_id = NULL WHERE id = '00000000-0000-0000-0001-0000000000a2'$$,
    '42501', NULL, 'service_role cannot relink a person');
SELECT lives_ok($$INSERT INTO public.invites (company_id, role, email, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'auditor', 'service@a.test', sha256('token-service'))$$,
    'service_role creates an invite');
SELECT lives_ok($$UPDATE public.invites SET token_hash = sha256('token-a3-resent'), expires_at = now() + interval '7 days'
    WHERE id = '00000000-0000-0000-0002-0000000000a3'$$, 'service_role resends an invite');
SELECT throws_ok($$UPDATE public.invites SET accepted_at = now() WHERE id = '00000000-0000-0000-0002-0000000000a3'$$,
    '42501', NULL, 'service_role cannot mark an invite accepted');
SELECT throws_ok($$INSERT INTO public.memberships (user_id, company_id, role)
    VALUES ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-00000000000a', 'admin')$$,
    '42501', NULL, 'service_role cannot create memberships');
RESET ROLE;

-- Writes: admin A
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a1');
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO public.people (company_id, name, email, kind)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'New A', 'new@a.test', 'contractor')$$,
    'admin adds a person to own company');
SELECT throws_ok($$INSERT INTO public.people (company_id, name, email, kind)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'Dup A', 'RECIPIENT@a.test', 'employee')$$,
    '23505', NULL, 'emails are unique per company, case-insensitively');
SELECT throws_ok($$INSERT INTO public.people (company_id, name, email, kind)
    VALUES ('00000000-0000-0000-0000-00000000000b', 'Sneaky', 'sneaky@b.test', 'employee')$$,
    '42501', NULL, 'admin cannot add a person to another company');
SELECT throws_ok($$INSERT INTO public.people (company_id, name, email, kind, status)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'Active', 'active@a.test', 'employee', 'active')$$,
    '42501', NULL, 'admin cannot insert an active person');
SELECT throws_ok($$INSERT INTO public.people (company_id, name, email, kind, user_id)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'Linked', 'linked@a.test', 'employee', '00000000-0000-0000-0000-0000000000a9')$$,
    '42501', NULL, 'admin cannot link a person to a user');
SELECT lives_ok($$UPDATE public.people SET name = 'Renamed', email = 'renamed@a.test', kind = 'supplier'
    WHERE id = '00000000-0000-0000-0001-0000000000a4'$$, 'admin edits name, email and kind');
SELECT throws_ok($$UPDATE public.people SET status = 'active' WHERE id = '00000000-0000-0000-0001-0000000000a4'$$,
    '23514', NULL, 'admin cannot activate a person');
SELECT throws_ok($$UPDATE public.people SET user_id = '00000000-0000-0000-0000-0000000000a9'
    WHERE id = '00000000-0000-0000-0001-0000000000a4'$$, '42501', NULL, 'admin cannot write user_id');
SELECT throws_ok($$UPDATE public.people SET company_id = '00000000-0000-0000-0000-00000000000b'
    WHERE id = '00000000-0000-0000-0001-0000000000a4'$$, '42501', NULL, 'admin cannot move a person');
SELECT lives_ok($$UPDATE public.people SET status = 'removed' WHERE id = '00000000-0000-0000-0001-0000000000a4'$$,
    'admin removes a person');
SELECT throws_ok($$UPDATE public.people SET status = 'pending' WHERE id = '00000000-0000-0000-0001-0000000000a4'$$,
    '23514', NULL, 'admin cannot restore a removed person');
SELECT throws_ok($$DELETE FROM public.people WHERE id = '00000000-0000-0000-0001-0000000000a4'$$,
    '42501', NULL, 'admin cannot delete people');
SELECT is_empty($$UPDATE public.people SET name = 'Hijacked' WHERE id = '00000000-0000-0000-0001-0000000000b2' RETURNING id$$,
    'admin cannot edit people of another company');
SELECT throws_ok($$INSERT INTO public.companies (name) VALUES ('Second')$$, '42501', NULL, 'admin cannot insert companies');
SELECT throws_ok($$UPDATE public.companies SET name = 'Renamed'$$, '42501', NULL, 'admin cannot update companies');
SELECT throws_ok($$INSERT INTO public.memberships (user_id, company_id, role)
    VALUES ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-00000000000a', 'auditor')$$,
    '42501', NULL, 'admin cannot insert memberships');
SELECT throws_ok($$UPDATE public.memberships SET role = 'admin'$$, '42501', NULL, 'admin cannot change roles');
SELECT throws_ok($$DELETE FROM public.memberships$$, '42501', NULL, 'admin cannot delete memberships');
SELECT throws_ok($$INSERT INTO public.invites (company_id, role, email, token_hash)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'auditor', 'x@a.test', sha256('x'))$$,
    '42501', NULL, 'admin cannot insert invites');
SELECT throws_ok($$UPDATE public.invites SET expires_at = now() + interval '1 year'$$,
    '42501', NULL, 'admin cannot update invites');
SELECT is_empty($$DELETE FROM public.invites WHERE id = '00000000-0000-0000-0002-0000000000b3' RETURNING id$$,
    'admin cannot delete invites of another company');
SELECT is_empty($$DELETE FROM public.invites WHERE id = '00000000-0000-0000-0002-0000000000a4' RETURNING id$$,
    'admin cannot delete recipient invites');
RESET ROLE;

-- Writes: recipient A and auditor A
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a2');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$INSERT INTO public.people (company_id, name, email, kind)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'Self', 'self@a.test', 'employee')$$,
    '42501', NULL, 'recipient cannot add people');
SELECT is_empty($$UPDATE public.people SET name = 'Me' WHERE id = '00000000-0000-0000-0001-0000000000a2' RETURNING id$$,
    'recipient cannot edit own person row');
SELECT is_empty($$DELETE FROM public.invites RETURNING id$$, 'recipient cannot delete invites');
RESET ROLE;
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a3');
SET LOCAL ROLE authenticated;
SELECT is_empty($$UPDATE public.people SET name = 'Audited' RETURNING id$$, 'auditor cannot edit people');
SELECT is_empty($$DELETE FROM public.invites RETURNING id$$, 'auditor cannot delete invites');
SELECT throws_ok($$INSERT INTO public.people (company_id, name, email, kind)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'Aud', 'aud@a.test', 'employee')$$,
    '42501', NULL, 'auditor cannot add people');
RESET ROLE;

-- A removed recipient still reads their own row.
UPDATE public.people SET status = 'removed' WHERE id = '00000000-0000-0000-0001-0000000000a2';
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a2');
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT status::text FROM public.people',
    $$VALUES ('removed')$$, 'removed recipient still reads own row');
RESET ROLE;

-- One admin per company; one membership per user.
SELECT throws_ok($$INSERT INTO public.memberships (user_id, company_id, role)
    VALUES ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-00000000000a', 'admin')$$,
    '23505', NULL, 'a company has at most one admin');
SELECT throws_ok($$INSERT INTO public.memberships (user_id, company_id, role)
    VALUES ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000000b', 'auditor')$$,
    '23505', NULL, 'a user has at most one membership');

SELECT * FROM finish();
ROLLBACK;
