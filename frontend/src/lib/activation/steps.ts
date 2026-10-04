import { base58FromBytes } from "@/lib/api/base58"
import { isApiError } from "@/lib/api/errors"
import type { createApiClient } from "@/lib/api/client"
import type { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { WalletUnavailableError, type Wallet } from "@/lib/wallet/types"
import { WalletCreationUnavailableError } from "./errors"
import type { StepRunners } from "./machine"
import { keyDerivationMessage } from "./message"

type Api = ReturnType<typeof createApiClient>

export type ActivationApi = {
  keys: Pick<Api["keys"], "enroll">
  accounts: Pick<Api["accounts"], "configure" | "confirmConfigure">
}

// The three steps as the functions that do them. Each is safe to run again: a
// retry after a failure calls only the steps that are not done.
export function createRunners({
  api,
  wallet,
  run,
  signal,
}: {
  api: ActivationApi
  wallet: Wallet
  run: ReturnType<typeof bindSignAndConfirm>
  signal?: AbortSignal
}): StepRunners {
  return {
    // Mock: the wallet exists from the start. Real: creating it is #78's route.
    wallet: async () => {
      if (wallet.status !== "ready") throw new WalletCreationUnavailableError()
    },

    key: async () => {
      const { signer, address } = wallet
      if (!signer.signMessage) {
        throw new WalletUnavailableError("the wallet cannot sign messages")
      }
      // Held only for this call: never stored, logged, put in a URL or in an error.
      const signature = base58FromBytes(
        await signer.signMessage(keyDerivationMessage(address)),
      )
      try {
        await api.keys.enroll(address, signature, { signal })
      } catch (error) {
        // Enrolled by an earlier try whose answer never arrived: that is the goal.
        if (isApiError(error) && error.code === "key_already_enrolled") return
        throw error
      }
    },

    account: async () => {
      const prepared = await api.accounts.configure(wallet.address, { signal })
      await run(
        prepared,
        (signature) =>
          api.accounts.confirmConfigure(
            { request_id: prepared.request_id, signature },
            { signal },
          ),
        undefined,
        { signal },
      )
    },
  }
}
