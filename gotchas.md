# Gotchas

- For #51, Turnkey is selected after a confirmed confidential v1 transfer on
  devnet. This supersedes the earlier Phantom-only preference. Keep production
  embedded onboarding and custody review open; the root-key spike does not
  establish user-controlled signing. Update earlier guidance when a decision
  changes so future work does not follow a superseded scope.

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
  on My Profile and the action is labelled New API Key.

- For #52's current local/frontend integration phase, the user explicitly chose
  wildcard CORS (`*`) and Brave with Phantom for browser checks. Keep cookies
  disabled and the configurable origin allowlist available; do not silently
  substitute a stricter default or another wallet.

- For #52, distinguish wrap from larger confidential transfers: fresh wrap fits
  v0 (812 bytes), even though confidential transfer needs v1. Test each flow.
  Phantom must use Testnet Mode / Solana Devnet for devnet previews. Successful
  transaction signing does not prove confidential-key enrollment: the SDK's
  canonical derivation message was rejected separately. Never substitute a new
  message or submit setup with discarded temporary keys just to pass an E2E test.
