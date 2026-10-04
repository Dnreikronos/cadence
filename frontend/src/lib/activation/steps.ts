import { base58FromBytes } from "@/lib/api/base58"
import { isApiError } from "@/lib/api/errors"
import type { createApiClient } from "@/lib/api/client"
import { ConfirmTimeoutError } from "@/lib/api/sign"
import type { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { WalletUnavailableError, type Wallet } from "@/lib/wallet/types"
import {
  KeyEnrolledElsewhereError,
  StepNotConfirmedError,
  WalletCreationUnavailableError,
} from "./errors"
import type { StepRunners } from "./machine"
import { keyDerivationMessage } from "./message"

type Api = ReturnType<typeof createApiClient>

export type ActivationApi = {
  keys: Pick<Api["keys"], "enroll">
  accounts: Pick<Api["accounts"], "configure" | "confirmConfigure">
  me: Pick<Api["me"], "status">
}

// A configure transaction that reached the network, by wallet. Neither field is a
// secret: a request id and a transaction signature are public. It outlives a failed
// run so a retry settles that transaction instead of preparing a second one.
export type SubmittedConfigure = { request_id: string; signature: string }
export type ConfigureAttempts = Map<string, SubmittedConfigure>

// The three steps as the functions that do them. A step is done only when the
// service says so: each re-reads the status after it ran, because a 409 on enroll
// can mean someone else enrolled this wallet's key first.
export function createRunners({
  api,
  wallet,
  run,
  signal,
  attempts,
}: {
  api: ActivationApi
  wallet: Wallet
  run: ReturnType<typeof bindSignAndConfirm>
  signal?: AbortSignal
  attempts: ConfigureAttempts
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
      // The only message this ever signs. Held only for this call: never stored,
      // logged, put in a URL or in an error.
      const bytes = await signer.signMessage(keyDerivationMessage(address))
      const signature = base58FromBytes(bytes)
      bytes.fill(0)
      let refused = false
      try {
        await api.keys.enroll(address, signature, { signal })
      } catch (error) {
        if (!(isApiError(error) && error.code === "key_already_enrolled")) {
          throw error
        }
        refused = true
      }
      // "Already enrolled" is the goal only if it is this wallet's key.
      const status = await api.me.status({ signal })
      if (!status.key_enrolled) {
        throw refused
          ? new KeyEnrolledElsewhereError()
          : new StepNotConfirmedError()
      }
    },

    account: async () => {
      const address = wallet.address
      const prior = attempts.get(address)
      // Whether the transaction in flight was settled, or refused for good: only
      // then may the next try prepare a new one.
      const settle = async (work: () => Promise<unknown>) => {
        try {
          await work()
        } catch (error) {
          if (isApiError(error) && !error.isRetryable) attempts.delete(address)
          throw error
        }
      }
      if (prior) {
        // Already on the network: settle that one, never prepare a second.
        if ((await api.me.status({ signal })).account_configured) {
          attempts.delete(address)
          return
        }
        await settle(async () => {
          try {
            await api.accounts.confirmConfigure(prior, { signal })
          } catch (error) {
            if (isApiError(error) && error.isRetryable) {
              throw new ConfirmTimeoutError(prior.signature)
            }
            throw error
          }
        })
      } else {
        await settle(async () => {
          const prepared = await api.accounts.configure(address, { signal })
          await run(
            prepared,
            (signature) =>
              api.accounts.confirmConfigure(
                { request_id: prepared.request_id, signature },
                { signal },
              ),
            undefined,
            {
              signal,
              onSubmitted: (signature) =>
                attempts.set(address, {
                  request_id: prepared.request_id,
                  signature,
                }),
            },
          )
        })
      }
      if (!(await api.me.status({ signal })).account_configured) {
        throw new StepNotConfirmedError()
      }
      attempts.delete(address)
    },
  }
}
