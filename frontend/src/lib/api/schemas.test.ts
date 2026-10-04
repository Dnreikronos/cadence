import { describe, expect, it } from "vitest"
import { ZodError } from "zod"
import {
  accessLogItemSchema,
  accountStatusSchema,
  auditorSchema,
  confirmRequestSchema,
  emailSchema,
  healthSchema,
  inviteAuditorRequestSchema,
  preparedSchema,
  receiptSchema,
  runRequestSchema,
  runSchema,
  transferRequestSchema,
  unitsSchema,
  unwrapRequestSchema,
  walletRequestSchema,
  wrapRequestSchema,
} from "./schemas"

const WALLET = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"
const SIG = "5SigMockSignature1111111111111111111111111111"
const REQUEST_ID = "a".repeat(64)
const AES_KEY = "AAAAAAAAAAAAAAAAAAAAAA=="
const GUID = "a0000000-0000-4000-8000-000000000001"

describe("unitsSchema", () => {
  it.each(["1", "281474976710655", "100000000000000"])(
    "accepts %j",
    (value) => {
      expect(unitsSchema.parse(value)).toBe(value)
    },
  )

  it.each([
    "0",
    "01",
    " 1",
    "1 ",
    "1\n",
    "-1",
    "+1",
    "",
    "1.5",
    "abc",
    "1e3",
    "0x10",
    "１２",
    "٣",
    "281474976710656",
    "9999999999999999",
  ])("refuses %j with a ZodError that does not echo it", (value) => {
    const result = unitsSchema.safeParse(value)
    expect(result.success).toBe(false)
    expect(() => unitsSchema.parse(value)).toThrow(ZodError)
    // Past the fixed message, nothing of the input is left in the error.
    const issues = result.error?.issues ?? []
    const rest = JSON.stringify(issues).replace(issues[0].message, "")
    if (value) expect(rest).not.toContain(value)
  })

  it.each([1000000, 1.5, null, undefined, 10n, {}])(
    "refuses the non-string %s",
    (value) => {
      expect(() => unitsSchema.parse(value)).toThrow(ZodError)
    },
  )
})

describe("request formats", () => {
  const wrap = { company_wallet: WALLET, amount: "1000000" }

  it("rejects unknown keys on every request", () => {
    const cases = [
      [wrapRequestSchema, wrap],
      [confirmRequestSchema, { request_id: REQUEST_ID, signature: SIG }],
      [walletRequestSchema, { wallet: WALLET }],
      [
        unwrapRequestSchema,
        { wallet: WALLET, amount: "1", acknowledge_reveal_risk: false },
      ],
      [
        runRequestSchema,
        {
          company_wallet: WALLET,
          payments: [{ person_id: GUID, amount: "1" }],
          idempotency_key: GUID,
        },
      ],
    ] as const
    for (const [schema, value] of cases) {
      expect(schema.safeParse(value).success).toBe(true)
      expect(() => schema.parse({ ...value, extra: 1 })).toThrow(ZodError)
    }
    expect(() =>
      runRequestSchema.parse({
        company_wallet: WALLET,
        payments: [{ person_id: GUID, amount: "1", note: "x" }],
        idempotency_key: GUID,
      }),
    ).toThrow(ZodError)
    expect(() =>
      wrapRequestSchema.parse({
        ...wrap,
        setup: {
          pubkey_validity_proof: "AAAA",
          decryptable_zero_balance: "AAAA",
          extra: "AAAA",
        },
      }),
    ).toThrow(ZodError)
  })

  it.each([
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["upper case", "A".repeat(64)],
    ["not hex", "g".repeat(64)],
  ])("refuses a request id that is %s", (_, requestId) => {
    expect(() =>
      confirmRequestSchema.parse({ request_id: requestId, signature: SIG }),
    ).toThrow(ZodError)
  })

  it.each([
    ["31 characters", WALLET.slice(0, 31), false],
    ["32 characters", WALLET.slice(0, 32), true],
    ["44 characters", WALLET, true],
    ["45 characters", WALLET + "1", false],
    ["a zero", "0" + WALLET.slice(1), false],
    ["a capital O", "O" + WALLET.slice(1), false],
    ["a capital I", "I" + WALLET.slice(1), false],
    ["a lower case l", "l" + WALLET.slice(1), false],
    ["a space", " " + WALLET.slice(1), false],
  ])("wallet with %s: accepted is %s", (_, wallet, ok) => {
    expect(walletRequestSchema.safeParse({ wallet }).success).toBe(ok)
  })

  it.each([
    ["42 characters", SIG.slice(0, 42), false],
    ["43 characters", SIG.slice(0, 43), true],
    ["88 characters", "1".repeat(88), true],
    ["89 characters", "1".repeat(89), false],
    ["a zero", "0".repeat(60), false],
    ["a lower case l", "l".repeat(60), false],
    ["sig", "sig", false],
  ])("signature with %s: accepted is %s", (_, signature, ok) => {
    expect(
      confirmRequestSchema.safeParse({ request_id: REQUEST_ID, signature })
        .success,
    ).toBe(ok)
  })

  it.each([
    [AES_KEY, true],
    ["AAAAAAAAAAAAAAAAAAAAAQ==", true],
    ["AAAAAAAAAAAAAAAAAAAAAB==", false],
    ["AAAAAAAAAAAAAAAAAAAA", false],
    ["AAAAAAAAAAAAAAAAAAAAAAAA", false],
    ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", false],
    ["AAAAAAAAAAAAAAAAAAAAA-==", false],
    ["", false],
  ])("aes key %j: accepted is %s", (aes_key, ok) => {
    expect(
      transferRequestSchema.safeParse({
        company_wallet: WALLET,
        sender: WALLET,
        recipient: WALLET,
        amount: "1",
        aes_key,
      }).success,
    ).toBe(ok)
  })
})

describe("response formats", () => {
  it("accepts a UTC offset as well as Z in timestamps", () => {
    for (const created_at of [
      "2026-09-01T12:00:00Z",
      "2026-09-01T12:00:00+00:00",
      "2026-09-01T12:00:00.123456+02:00",
    ]) {
      expect(
        runSchema.safeParse({ run_id: GUID, created_at, payments: [] }).success,
      ).toBe(true)
    }
    expect(
      runSchema.safeParse({
        run_id: GUID,
        created_at: "yesterday",
        payments: [],
      }).success,
    ).toBe(false)
  })

  it("stays lenient about extra keys but not about the request id", () => {
    const prepared = {
      request_id: REQUEST_ID,
      transaction: "AAAA",
      transaction_version: 1,
      required_signers: [WALLET],
      recent_blockhash: "hash",
      last_valid_block_height: 1,
      added_later: true,
    }
    expect(preparedSchema.safeParse(prepared).success).toBe(true)
    expect(
      preparedSchema.safeParse({ ...prepared, request_id: "A".repeat(64) })
        .success,
    ).toBe(false)
    expect(
      receiptSchema.safeParse({
        request_id: REQUEST_ID,
        signature: "any",
        slot: 1,
        status: "finalized",
      }).success,
    ).toBe(true)
  })

  it("reads a 503 health body without a build sha", () => {
    expect(
      healthSchema.parse({ status: "unavailable", rpc_reachable: false }),
    ).toEqual({ status: "unavailable", rpc_reachable: false })
  })
})

describe("emailSchema", () => {
  it.each([
    "a@b",
    "ana.ribeiro@northwind-audit.example",
    "a+tag@b.co",
    `${"a".repeat(315)}@b.co`,
  ])("accepts %j", (value) => {
    expect(emailSchema.parse(value)).toBe(value)
  })

  it.each([
    "",
    "plain",
    "@b.co",
    "a@",
    "a@@b.co",
    "a@b@c",
    "a b@c.d",
    "a@b c",
    " a@b.co",
    "a@b.co ",
    "a@b.co\n",
    "a\t@b.co",
    `${"a".repeat(316)}@b.co`,
  ])("refuses %j", (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false)
  })

  it.each([1, null, undefined, {}])("refuses the non-string %s", (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false)
  })

  it("is the one rule of the invite request, which is strict", () => {
    expect(inviteAuditorRequestSchema.parse({ email: "a@b.co" })).toEqual({
      email: "a@b.co",
    })
    for (const body of [
      {},
      { email: "nope" },
      { email: "a@b.co", role: "admin" },
    ]) {
      expect(inviteAuditorRequestSchema.safeParse(body).success).toBe(false)
    }
  })
})

describe("auditors, access log and account status", () => {
  const auditor = {
    id: GUID,
    email: "ana@audit.example",
    status: "invite-expired",
    invited_at: "2026-10-02T09:00:00+00:00",
  }
  const row = {
    id: GUID,
    at: "2026-10-03T18:00:00Z",
    actor: { kind: "auditor", label: "Ana Ribeiro" },
    action: "export_csv",
    scope: "Company payments",
  }

  it("reads the three auditor statuses and an offset timestamp, not another status", () => {
    for (const status of ["invited", "active", "invite-expired"]) {
      expect(auditorSchema.parse({ ...auditor, status }).status).toBe(status)
    }
    for (const status of ["revoked", "Active", ""]) {
      expect(auditorSchema.safeParse({ ...auditor, status }).success).toBe(
        false,
      )
    }
    expect(
      auditorSchema.safeParse({ ...auditor, invited_at: "yesterday" }).success,
    ).toBe(false)
    expect(auditorSchema.safeParse({ ...auditor, id: "x" }).success).toBe(false)
  })

  it("reads every access-log actor and action, and refuses the rest", () => {
    for (const kind of ["service", "company", "recipient", "auditor"]) {
      expect(
        accessLogItemSchema.safeParse({ ...row, actor: { kind, label: "x" } })
          .success,
      ).toBe(true)
    }
    for (const action of ["read_payments", "read_balance", "export_csv"]) {
      expect(accessLogItemSchema.safeParse({ ...row, action }).success).toBe(
        true,
      )
    }
    for (const bad of [
      { actor: { kind: "admin", label: "x" } },
      { actor: { kind: "auditor" } },
      { action: "write_payments" },
      { scope: 5 },
      { at: "2026-10-03" },
    ]) {
      expect(accessLogItemSchema.safeParse({ ...row, ...bad }).success).toBe(
        false,
      )
    }
  })

  it("needs all four booleans of the account status", () => {
    const status = {
      wallet_linked: true,
      key_enrolled: true,
      account_configured: false,
      pending_credits: false,
    }
    expect(accountStatusSchema.parse({ ...status, added_later: 1 })).toEqual(
      status,
    )
    for (const key of Object.keys(status)) {
      const rest: Record<string, boolean> = { ...status }
      delete rest[key]
      expect(accountStatusSchema.safeParse(rest).success, key).toBe(false)
      expect(
        accountStatusSchema.safeParse({ ...status, [key]: "true" }).success,
        key,
      ).toBe(false)
    }
  })
})
