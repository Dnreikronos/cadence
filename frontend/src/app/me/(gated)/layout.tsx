import { ActivationGate } from "../activation-gate"

// The recipient's screens wait for an account that is set up (`ActivationGate`). Not the
// not-found page next to this group: the gate renders its children on the client only, so
// a 404 thrown under it is raised after the response has started, and answers 200. Outside
// it, an address no page answers is a real 404, like the company's.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ActivationGate>{children}</ActivationGate>
}
