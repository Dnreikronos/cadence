import { walletAccounts } from "./accounts"
import {
  UnexpectedTransactionError,
  checkFlow,
  type InspectedTransaction,
} from "./inspect"

// What a flow's sign call passes as its pre-sign check (`signAndConfirm`'s `check`):
// the flow, and what the person asked for. Every account is derived here from the
// wallet, never read from what the service answered.
export type FlowRequest =
  // Integer base units, as the person entered them.
  { flow: "wrap" | "unwrap"; amount: string } | { flow: "configure" | "apply" }

export type TransactionCheck = (
  transaction: InspectedTransaction,
) => void | Promise<void>

export function flowCheck(
  wallet: string,
  request: FlowRequest,
): TransactionCheck {
  return async (transaction) => {
    const accounts = await walletAccounts(wallet)
    if (!("amount" in request)) {
      return checkFlow(transaction, { flow: request.flow, accounts })
    }
    if (!/^\d{1,20}$/.test(request.amount)) {
      throw new UnexpectedTransactionError("amount")
    }
    checkFlow(transaction, {
      flow: request.flow,
      accounts,
      amount: BigInt(request.amount),
    })
  }
}
