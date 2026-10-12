# Encrypted roster amounts

Issue [#64](https://github.com/Dnreikronos/cadence/issues/64).
Scope is backend/web3. Frontend implementation belongs to the frontend team.

## Contract and implementation

The existing roster routes store amounts in Supabase Vault with company/person
context binding. Company admins can access their own people. Unset amounts remain
null, and removed or foreign-company people cannot be updated. A committed,
attributed audit record must precede every roster read, including empty pages and
reads whose decryption later fails.

Successful PUT and POST writes previously returned only a status acknowledgement.
Both now return the normalized person ID and canonical, non-null base-unit amount
after storage succeeds. The response uses the accepted write without another
decryption or read audit. Request and typed response strings are zeroized on drop;
the parsed integer is also zeroized. The current main branch's admin checks and
Vault concurrency permit are preserved. No new migration is needed.

The dedicated `roster_amounts` integration target uses the existing disposable
Vault fixture. It checks HTTP authentication and response headers, updates without
orphaned secrets, nullable reads, paging and empty-page audits, company boundaries,
recipient/auditor denial, removed-person denial and direct-access permissions.
Further checks reject unsafe parameter logging, uncommitted/wrong-scope/reused
permits, failed audit insertion and payload context corruption. Two actual dumps
contain the scenario's stored secret and no plaintext fixture amounts or encoded
plaintext payloads. The ciphertext-at-write fixture checks Vault writes before
heap/WAL persistence. Successful-write assertions cover the exact response fields
and POST normalization without an additional read audit.

CI runs the target in its own Vault matrix job and passes the service container ID
for the dump check. The broad Supabase service role retains its existing privileged
Vault access inside the trust boundary described by the key-storage design.

## Locally executed checks

The shipping branch was created from current `origin/main` at `33755d3` in an
isolated checkout. Each commit's staged snapshot passed
`rtk cargo check --locked --all-targets` before committing.

| Check | Result |
| --- | --- |
| Rust formatting | Passed. |
| Clippy with `-D warnings` | Passed, with the existing vendored token-client deprecation warning. |
| Existing `owner_reads_http` integration | Passed on a fresh Supabase/Vault database. |
| Roster privacy acceptance | Passed on a separate fresh database. |
| Roster response and normalization regression | Passed on another fresh database. |
| Workflow YAML and dump-container configuration | Validated. |
| Diff whitespace | Passed. |

The earlier headed skel-test rerun tested the response fix in the shared checkout
before this branch was packaged. Real UI saves returned the corrected response,
the client accepted it, and independent reads after reload confirmed saved amounts.
The browser gate still had one pass and three display failures because the
frontend rejects nullable roster reads. Recipient navigation and read/write denial
passed. These results do not establish a clean E2E pass on this shipping branch.
Raw browser evidence remains local because traces can contain session data.

The full suite was not run. Hosted CI is separate from these local results.
Disposable databases created for these checks are removed after verification;
existing development databases are preserved.

## Running the roster target

Prepare a fresh disposable database with `tests/support/vault.sql`, following the
[Vault test instructions](../../services/proof/README.md#local-vault-integration-test).
Run from `services/proof` with `TRANSFER_TEST_DATABASE_URL` pointing to that
database and `ROSTER_TEST_DUMP_CONTAINER` naming its Docker container. The database
must be named `keys_test` for the dump command.

```bash
rtk cargo test --locked --test roster_amounts -- --ignored
```

The tests apply migrations to an empty instance. Do not reuse a populated database
or run a second integration target on that same instance.

The [API reference](../dev/WEB3_API.md) describes the write response. The
[frontend handoff](../dev/WEB3_INTEGRATION_HANDOFF.md) documents nullable reads and
the frontend handling still required.
