"use client"

import { useState } from "react"
import {
  apiConfig,
  api,
  messageFor,
  isApiError,
  signAndConfirm,
} from "@/lib/api"
import { COMPANY_WALLET, ME_WALLET, seedPeople } from "@/lib/api/mocks/db"
import { mockSigner, mockSubmit } from "@/lib/api/mocks/signer"
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
  const [active, setActive] = useState<Scenario[]>(scenarios.list())
  const [busy, setBusy] = useState(false)
  const write = (line: string) => setLog((lines) => [...lines, line])

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
        onStep: (step) => write(`  ${step}`),
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
        payments: people.map((p) => ({
          person_id: p.id,
          amount: "1000000000",
        })),
        idempotency_key: crypto.randomUUID(),
      })
      for (const payment of created.payments) {
        try {
          await signAndConfirm(payment, {
            signer: mockSigner(COMPANY_WALLET),
            submit: mockSubmit,
            confirm: (signature) =>
              api.runs.confirmPayment(
                created.run_id,
                payment.payment_id,
                signature,
              ),
          })
        } catch (error) {
          write(
            `  payment ${payment.payment_id.slice(0, 4)} failed: ${isApiError(error) ? error.code : "error"}`,
          )
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
      </header>

      <fieldset className="flex flex-wrap gap-2">
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
          disabled={busy}
          onClick={wrap}
          className={buttonVariants({ size: "sm" })}
        >
          Wrap 2,500
        </button>
        <button
          disabled={busy}
          onClick={payroll}
          className={buttonVariants({ size: "sm" })}
        >
          Pay three people
        </button>
        <button
          disabled={busy}
          onClick={unwrap("4200000000", false)}
          className={buttonVariants({ size: "sm", variant: "secondary" })}
        >
          Withdraw 4,200 (no ack)
        </button>
        <button
          disabled={busy}
          onClick={unwrap("4200000000", true)}
          className={buttonVariants({ size: "sm", variant: "secondary" })}
        >
          Withdraw 4,200 (ack)
        </button>
        <button
          disabled={busy}
          onClick={unwrap("1234567", false)}
          className={buttonVariants({ size: "sm", variant: "secondary" })}
        >
          Withdraw 1.23
        </button>
        <button
          onClick={() => setLog([])}
          className={buttonVariants({ size: "sm", variant: "secondary" })}
        >
          Clear
        </button>
      </div>

      <pre
        aria-live="polite"
        className="min-h-40 overflow-x-auto rounded-xl border border-line bg-surface p-4 font-mono text-caption/relaxed"
      >
        {log.join("\n") || "Nothing run yet."}
      </pre>
    </main>
  )
}
