"use client"

import { useEffect, useState } from "react"
import {
  apiConfig,
  api,
  messageFor,
  isApiError,
  signAndConfirm,
  whenApiReady,
} from "@/lib/api"
import { COMPANY_WALLET, ME_WALLET, seedPeople } from "@/lib/api/mocks/db"
import { mockSigner, mockSubmit } from "@/lib/api/mocks/signer"
import { mockFinality, mockTokenAccount } from "@/lib/api/mocks/chain"
import type { RunConfirmRequest } from "@/lib/api/schemas"
import { confirmPosition, signablesOf } from "@/lib/runs/executor"
import { wrapAccounts } from "@/lib/solana/accounts"
import { flowCheck } from "@/lib/solana/flow-check"
import { checkConfidentialTransfer } from "@/lib/solana/inspect"
import {
  scenarioNames,
  scenarios,
  type Scenario,
} from "@/lib/api/mocks/scenario"
import { buttonVariants } from "@/components/ui/button"

// A place to run the contract's flows against the mock service and flip its
// failure scenarios, until the real screens use the client.
export function ApiPlayground() {
  const [log, setLog] = useState<string[]>([])
  // Empty until mounted: the worker applies `?mock=` only once it has started.
  const [active, setActive] = useState<Scenario[]>([])
  const [busy, setBusy] = useState(false)
  const write = (line: string) => setLog((lines) => [...lines, line])
  // The flows use fake wallets, so against the real service they only fail.
  const mock = apiConfig.mode === "mock"

  useEffect(() => {
    let live = true
    whenApiReady()
      .then(() => live && setActive(scenarios.list()))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // aria-disabled keeps focus on the button, so the click is guarded here.
  const off = busy || !mock
  const guarded = (action: () => void) => () => {
    if (!off) action()
  }
  const button = (variant?: "secondary") =>
    buttonVariants({
      size: "sm",
      variant,
      className: "aria-disabled:pointer-events-none aria-disabled:opacity-50",
    })

  async function run(title: string, flow: () => Promise<void>) {
    setBusy(true)
    write(`> ${title}`)
    try {
      await flow()
      write("  done")
    } catch (error) {
      write(
        isApiError(error)
          ? `  ${error.status} ${error.code}: ${messageFor(error)}`
          : `  ${error instanceof Error ? error.name : "error"}: ${error instanceof Error ? error.message : ""}`,
      )
    } finally {
      setBusy(false)
    }
  }

  const wrap = () =>
    run("Wrap 2,500 USDC", async () => {
      const prepared = await api.wrap.prepare({
        company_wallet: COMPANY_WALLET,
        amount: "2500000000",
      })
      write(
        `  prepared ${prepared.request_id.slice(-8)} (v${prepared.transaction_version})`,
      )
      const receipt = await signAndConfirm(prepared, {
        signer: mockSigner(COMPANY_WALLET),
        submit: mockSubmit,
        finality: mockFinality,
        onStep: (step) => write(`  ${step}`),
        check: flowCheck(COMPANY_WALLET, {
          flow: "wrap",
          amount: "2500000000",
        }),
        confirm: (signature) =>
          api.wrap.confirm({ request_id: prepared.request_id, signature }),
      })
      write(`  finalized at slot ${receipt.slot}`)
    })

  const payroll = () =>
    run("Pay three people", async () => {
      const people = seedPeople.filter((p) => p.activated).slice(0, 3)
      const created = await api.runs.create({
        company_wallet: COMPANY_WALLET,
        sender: mockTokenAccount(COMPANY_WALLET),
        aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
        wallet_signature: "5SigMockSignature1111111111111111111111111111",
        payments: people.map((p) => ({
          recipient: mockTokenAccount(p.id),
          amount: "1000000000",
        })),
      })
      const runApi = {
        confirm: (runId: string, item: RunConfirmRequest["payments"][number]) =>
          api.runs.confirm(runId, { payments: [item] }),
        retry: api.runs.retry,
      }
      const { wrappedMint } = await wrapAccounts()
      // In position order, stopping at the first that does not finalize.
      for (const payment of signablesOf(created)) {
        try {
          await signAndConfirm(payment, {
            signer: mockSigner(COMPANY_WALLET),
            submit: mockSubmit,
            finality: mockFinality,
            // To the account asked for at this position.
            check: (transaction) =>
              checkConfidentialTransfer(transaction, {
                wallet: COMPANY_WALLET,
                sender: mockTokenAccount(COMPANY_WALLET),
                destination: mockTokenAccount(people[payment.position].id),
                mint: wrappedMint,
              }),
            confirm: (signature) =>
              confirmPosition(runApi, created.run_id, payment, signature),
          })
        } catch (error) {
          write(
            `  payment ${payment.position} failed: ${isApiError(error) ? error.code : "error"}`,
          )
          break
        }
      }
      const status = await api.runs.get(created.run_id)
      write(`  ${status.payments.map((p) => p.status).join(", ")}`)
    })

  const unwrap = (amount: string, acknowledge: boolean) => () =>
    run(
      `Withdraw ${amount} base units${acknowledge ? " (acknowledged)" : ""}`,
      async () => {
        const prepared = await api.unwrap.prepare({
          wallet: ME_WALLET,
          amount,
          aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
          acknowledge_reveal_risk: acknowledge,
        })
        write(`  reveal risk: ${prepared.reveal_risk.level}`)
      },
    )

  function toggle(name: Scenario) {
    const next = active.includes(name)
      ? active.filter((n) => n !== name)
      : [...active, name]
    scenarios.set(...next)
    setActive(next)
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-title">API playground</h1>
        <p className="mt-1 text-ui text-ink-muted">
          Mode: <code className="font-mono">{apiConfig.mode}</code>. Runs the
          contract&apos;s flows and flips the mock&apos;s failure scenarios.
        </p>
        {!mock && (
          <p className="mt-2 text-ui text-ink" role="note">
            The controls are off: they send fake wallets, which would hit the
            real service. Set NEXT_PUBLIC_API_MODE to mock to use them.
          </p>
        )}
      </header>

      <fieldset disabled={!mock} className="flex flex-wrap gap-2">
        <legend className="mb-2 text-label text-ink-muted uppercase">
          Scenarios
        </legend>
        {scenarioNames.map((name) => (
          <label
            key={name}
            className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-caption"
          >
            <input
              type="checkbox"
              checked={active.includes(name)}
              onChange={() => toggle(name)}
            />
            {name}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <button
          aria-disabled={off || undefined}
          onClick={guarded(wrap)}
          className={button()}
        >
          Wrap 2,500
        </button>
        <button
          aria-disabled={off || undefined}
          onClick={guarded(payroll)}
          className={button()}
        >
          Pay three people
        </button>
        <button
          aria-disabled={off || undefined}
          onClick={guarded(unwrap("4200000000", false))}
          className={button("secondary")}
        >
          Withdraw 4,200 (no ack)
        </button>
        <button
          aria-disabled={off || undefined}
          onClick={guarded(unwrap("4200000000", true))}
          className={button("secondary")}
        >
          Withdraw 4,200 (ack)
        </button>
        <button
          aria-disabled={off || undefined}
          onClick={guarded(unwrap("1234567", false))}
          className={button("secondary")}
        >
          Withdraw 1.23
        </button>
        <button onClick={() => setLog([])} className={button("secondary")}>
          Clear
        </button>
      </div>

      <pre
        role="log"
        aria-label="Flow log"
        className="min-h-40 overflow-x-auto rounded-xl border border-line bg-surface p-4 font-mono text-caption/relaxed"
      >
        {log.join("\n") || "Nothing run yet."}
      </pre>
    </main>
  )
}
