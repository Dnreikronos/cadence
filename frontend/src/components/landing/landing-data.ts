export { formatUsd } from "@/lib/format"

export type Perspective =
  "company" | "recipient" | "auditor" | "cadence" | "public"

export type Payment = {
  id: string
  name: string
  kind: string
  initials: string
  amount: number
  cipher: string
}

export const perspectives: {
  id: Perspective
  label: string
  holder: string
  initials: string | null
  caption: string
}[] = [
  {
    id: "company",
    label: "Company",
    holder: "Ana Lima, COO",
    initials: "AL",
    caption: "Sees every payment Solaris made.",
  },
  {
    id: "recipient",
    label: "Recipient",
    holder: "Bruno Costa",
    initials: "BC",
    caption: "Sees what he was paid, not his colleagues' pay.",
  },
  {
    id: "auditor",
    label: "Auditor",
    holder: "Carla Reis",
    initials: "CR",
    caption: "Sees every amount. Reads are meant to be logged.",
  },
  {
    id: "cadence",
    label: "Cadence",
    holder: "The proof service",
    initials: null,
    caption:
      "Reads amounts to generate proofs. Payments are signed in your wallet.",
  },
  {
    id: "public",
    label: "Public",
    holder: "Anyone with an RPC",
    initials: null,
    caption: "Sees addresses and times, and ciphertext instead of amounts.",
  },
]

export const recipientId = "bruno"

export const payments: Payment[] = [
  {
    id: "bruno",
    name: "Bruno Costa",
    kind: "Salary",
    initials: "BC",
    amount: 4200,
    cipher: "9f3a·e71b·04c2·c21e",
  },
  {
    id: "ana",
    name: "Ana Lima",
    kind: "Salary",
    initials: "AL",
    amount: 5100,
    cipher: "2b8d·f09a·7e13·aa40",
  },
  {
    id: "mariana",
    name: "Mariana Souza",
    kind: "Salary",
    initials: "MS",
    amount: 3800,
    cipher: "c4e0·19bf·d2a7·5b93",
  },
  {
    id: "diego",
    name: "Diego Martins",
    kind: "Contractor",
    initials: "DM",
    amount: 6300,
    cipher: "58ab·02ce·91df·7a64",
  },
  {
    id: "northwind",
    name: "Northwind Audit",
    kind: "Supplier",
    initials: "NA",
    amount: 9500,
    cipher: "71fa·3c6e·b845·0d2f",
  },
]

export function canSee(perspective: Perspective, payment: Payment) {
  if (perspective === "public") return false
  if (perspective === "recipient") return payment.id === recipientId
  return true
}
