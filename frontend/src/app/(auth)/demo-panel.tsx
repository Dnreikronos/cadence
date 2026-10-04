import { signInAsDemo, signInAsNewRecipient } from "@/lib/demo/actions"
import { demoViewer } from "@/lib/demo/viewer"
import type { Role } from "@/lib/auth/guard"

const choices: { role: Role; title: string; detail: string }[] = [
  {
    role: "admin",
    title: "Company admin",
    detail: "Runs payroll and deposits",
  },
  { role: "recipient", title: "Recipient", detail: "Gets paid and withdraws" },
  { role: "auditor", title: "Auditor", detail: "Reads the company's payments" },
]

// Shown only where the demo is enabled: no real sign-in exists there.
export function DemoPanel({ next }: { next?: string | null }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">
        Try the demo
      </h1>
      <p className="mt-2 text-ui/normal text-ink-muted">
        Pick who to be. Email sign-in needs Supabase, which is not set up here.
      </p>
      <form action={signInAsDemo} className="mt-5 space-y-2">
        {next && <input type="hidden" name="next" value={next} />}
        {choices.map(({ role, title, detail }) => (
          <button
            key={role}
            type="submit"
            name="role"
            value={role}
            className="flex w-full flex-col gap-0.5 rounded-xl border border-line bg-surface px-4 py-3 text-left transition-colors duration-150 hover:border-ink/25 hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <span className="text-ui font-medium text-ink">{title}</span>
            <span className="text-label text-ink-muted">
              {detail} · {demoViewer(role).email}
            </span>
          </button>
        ))}
        {/* A recipient with nothing set up, to see the activation screen. */}
        <button
          type="submit"
          formAction={signInAsNewRecipient}
          className="flex w-full flex-col gap-0.5 rounded-xl border border-line bg-surface px-4 py-3 text-left transition-colors duration-150 hover:border-ink/25 hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <span className="text-ui font-medium text-ink">
            New recipient (shows activation)
          </span>
          <span className="text-label text-ink-muted">
            Sets up a wallet and keys first · {demoViewer("recipient").email}
          </span>
        </button>
      </form>
      <p className="mt-4 text-label text-ink-muted">
        Everything here is fake data: balances, people and payments reset when
        you reload the page.
      </p>
    </div>
  )
}
