# Gotchas

- For #50, the user does not want to provision AWS, Azure, or a similar cloud
  account for key management. Establish the operational constraint before
  offering provider choices. Prefer existing infrastructure where appropriate,
  and explicitly explain any change to the issue's separate-KMS requirement.

- Supabase's `postgres` role is not the extension superuser. Test migrations with
  hosted-equivalent grants. Vault 0.3.1 `create_secret` temporarily inserts its
  argument in plaintext; create an empty placeholder and use `update_secret`
  for the real payload. Do not assume the low-level encryption function is
  available to hosted migrations.
- PostgreSQL snapshots omit the current transaction from the in-progress set.
  A durable audit gate must exclude its own top-level transaction explicitly;
  test with a concurrent transaction advancing the global ID counter. Do not
  use tuple xmin for this check because PL/pgSQL exception blocks use subtransactions.
