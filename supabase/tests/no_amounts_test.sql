-- Postgres never stores a plaintext amount (B12).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(3);

CREATE TEMP TABLE swept AS
    SELECT table_name::text, column_name::text, data_type::text
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('companies', 'memberships', 'people', 'invites');

SELECT is((SELECT count(DISTINCT table_name) FROM swept), 4::bigint, 'every tenancy table is swept');
SELECT is_empty($$
    SELECT table_name || '.' || column_name FROM swept
    WHERE column_name ~* '(amount|salary|wage|pay|compensation|value|price|rate|balance|total|sum)'
$$, 'no amount-like column names');
SELECT is_empty($$
    SELECT table_name || '.' || column_name FROM swept
    WHERE data_type IN ('numeric', 'money', 'real', 'double precision', 'smallint', 'integer', 'bigint')
$$, 'no numeric columns');

SELECT * FROM finish();
ROLLBACK;
