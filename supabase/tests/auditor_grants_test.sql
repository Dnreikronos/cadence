BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
-- Supabase gives postgres ADMIN OPTION but not SET on freshly created roles.
GRANT cadence_audit_service TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA extensions TO cadence_audit_service;
SELECT plan(21);

INSERT INTO auth.users (id) VALUES
    ('11111111-1111-4111-8111-111111111111'),
    ('22222222-2222-4222-8222-222222222222'),
    ('33333333-3333-4333-8333-333333333333'),
    ('44444444-4444-4444-8444-444444444444'),
    ('55555555-5555-4555-8555-555555555555');
INSERT INTO public.companies (id, name) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Solaris'),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Other company');
INSERT INTO public.memberships (user_id, company_id, role) VALUES
    ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin'),
    ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin'),
    ('33333333-3333-4333-8333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'auditor'),
    ('44444444-4444-4444-8444-444444444444', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'auditor'),
    ('55555555-5555-4555-8555-555555555555', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'auditor');
DELETE FROM public.auditor_grants WHERE user_id = '55555555-5555-4555-8555-555555555555';
SELECT is((SELECT count(*) FROM public.auditor_grants), 2::bigint, 'accepted auditors receive explicit grants');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SELECT is((SELECT count(*) FROM public.auditor_grants), 1::bigint, 'auditor reads only their own grant');
SELECT is((SELECT count(*) FROM public.auditor_grants WHERE company_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 0::bigint, 'grant on A reveals no grant on B');
SELECT throws_ok($$INSERT INTO public.auditor_grants (company_id, user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '55555555-5555-4555-8555-555555555555')$$,
    '42501', NULL, 'auditor cannot self-designate another caller');
WITH deleted AS (DELETE FROM public.auditor_grants RETURNING id)
SELECT is((SELECT count(*) FROM deleted), 0::bigint, 'auditor cannot revoke grants');

SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT lives_ok($$INSERT INTO public.auditor_grants (company_id, user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '55555555-5555-4555-8555-555555555555')$$, 'admin grants access in own company');
SELECT throws_ok($$INSERT INTO public.auditor_grants (company_id, user_id) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555')$$,
    '42501', NULL, 'admin cannot grant another company');
SELECT throws_ok($$INSERT INTO public.auditor_grants (company_id, user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '44444444-4444-4444-8444-444444444444')$$,
    '23503', NULL, 'membership foreign key prevents cross-company identities');
WITH deleted AS (DELETE FROM public.auditor_grants WHERE company_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' RETURNING id)
SELECT is((SELECT count(*) FROM deleted), 0::bigint, 'admin cannot revoke another company');
WITH deleted AS (DELETE FROM public.auditor_grants WHERE user_id = '55555555-5555-4555-8555-555555555555' RETURNING id)
SELECT is((SELECT count(*) FROM deleted), 1::bigint, 'admin revokes own company grant');

RESET ROLE;
SET LOCAL ROLE cadence_audit_service;
SET LOCAL request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SELECT lives_ok($$SELECT cadence_private.audit_company_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 20, NULL)$$, 'designated caller can audit own company');
SELECT throws_ok($$SELECT cadence_private.audit_company_read('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 20, NULL)$$, 'CD404', 'audit scope not found', 'same chain access cannot audit another company');
SELECT throws_ok($$SELECT * FROM cadence_private.viewing_keys$$, '42501', NULL, 'audit role cannot bypass the key accessor');
SELECT throws_ok($$SELECT * FROM vault.decrypted_secrets$$, '42501', NULL, 'audit role cannot read Vault directly');
SELECT throws_ok($$SELECT cadence_private.audit_key_read('actor', 'reason', '11111111111111111111111111111111')$$, '42501', NULL, 'audit role cannot issue unrestricted key permits');
SELECT throws_ok($$UPDATE public.decryption_audit_log SET reason = 'changed'$$, '42501', NULL, 'audit role cannot alter the log');
SELECT throws_ok($$DELETE FROM public.decryption_audit_log$$, '42501', NULL, 'audit role cannot delete the log');
SELECT throws_ok($$SELECT * FROM cadence_private.company_payment_receipts$$, '42501', NULL, 'audit role cannot read unscoped receipts');
SET LOCAL request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';
SELECT throws_ok($$SELECT cadence_private.audit_company_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 20, NULL)$$, 'CD404', 'audit scope not found', 'same membership without grant receives nothing');
RESET ROLE;
SELECT is((SELECT count(*) FROM public.decryption_audit_log WHERE target_company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 1::bigint, 'one row per authorized request, none for denied requests');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.auditor_grants$$, '42501', NULL, 'anonymous caller cannot read grants');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
