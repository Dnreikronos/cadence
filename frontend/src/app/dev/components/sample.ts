import type { PaymentStatus } from "@/components/ui/status-pill"

export const samplePayments: {
  id: string
  name: string
  initials: string
  kind: string
  amount: number
  status: PaymentStatus
  isTransparent?: boolean
}[] = [
  {
    id: "a",
    name: "Bruno Costa",
    initials: "BC",
    kind: "Salary",
    amount: 4200,
    status: "confirmed",
  },
  {
    id: "b",
    name: "Mariana Souza",
    initials: "MS",
    kind: "Salary",
    amount: 3800,
    status: "pending",
  },
  {
    id: "c",
    name: "Diego Martins",
    initials: "DM",
    kind: "Contractor",
    amount: 6300,
    status: "failed",
  },
  {
    id: "d",
    name: "Northwind Audit",
    initials: "NA",
    kind: "Supplier",
    amount: 9500,
    status: "confirmed",
    isTransparent: true,
  },
]
