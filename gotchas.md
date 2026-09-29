# Gotchas

- For #51, the user chose an existing Phantom wallet over creating Turnkey/Privy
  accounts. Treat embedded onboarding as deferred and verify installed-wallet
  v1 transaction support before promising that this alternative works.

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

- Cluster guards must compare the complete genesis hash, not an abbreviated
  identifier. Verify it against independent RPCs and test rejection of truncated
  values before live provider experiments.

- For Turnkey dashboard guidance, inspect the current UI first. API Keys lives
  on My Profile and the action is labelled New API Key. The user has now
  provisioned Turnkey, superseding the earlier Phantom-only preference.
