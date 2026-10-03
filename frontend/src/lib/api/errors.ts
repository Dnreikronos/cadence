import { errorBodySchema } from "./schemas"

// The code is the contract. Copy lives here so it can change without a backend
// release. An error never carries a value from the request.
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  // Seconds, from Retry-After on a 429.
  readonly retryAfter?: number

  constructor(status: number, code: string, retryAfter?: number) {
    super(code)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }

  // "Not yet" and "service busy": the same request may succeed later. 502 to
  // 504 are what a proxy answers while the service restarts.
  get isRetryable() {
    return (
      this.code === "transaction_not_finalized" ||
      this.status === 429 ||
      (this.status >= 502 && this.status <= 504) ||
      this.code === "network_error"
    )
  }
}

// The service answered with a shape the contract does not allow.
export class ContractError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Response from ${path} does not match the API contract`)
    this.name = "ContractError"
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

// The service always answers a 429 with Retry-After: 60, but CORS does not expose
// that header to cross-origin browser code, so an unreadable one means 60 s.
const RATE_LIMIT_WAIT = 60

export function errorFromResponse(response: Response, body: unknown) {
  const parsed = errorBodySchema.safeParse(body)
  const header = Number(response.headers.get("retry-after"))
  const retryAfter =
    Number.isFinite(header) && header > 0
      ? header
      : response.status === 429
        ? RATE_LIMIT_WAIT
        : undefined
  return new ApiError(
    response.status,
    parsed.success ? parsed.data.error : statusFallback(response.status),
    retryAfter,
  )
}

// An unknown code is handled as its status class, so new codes are not breaking.
function statusFallback(status: number) {
  if (status === 401) return "authentication_required"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  if (status === 429) return "rate_limited"
  if (status >= 500) return "service_unavailable"
  return "request_failed"
}

const messages: Record<string, string> = {
  authentication_required: "Your session ended. Sign in again to continue.",
  forbidden_role: "Your account can't do that.",
  wallet_access_denied: "This wallet isn't linked to your account.",
  wallet_link_required: "Link your wallet to your account first.",
  invalid_amount: "That amount isn't valid.",
  invalid_request: "Something in the request was wrong. Try again.",
  confidential_setup_required:
    "This account needs to be set up for private payments first.",
  recipient_not_activated: "This person hasn't set up their account yet.",
  recipient_account_missing: "The recipient's account isn't ready yet.",
  sender_account_missing: "Your account isn't ready yet.",
  invalid_confidential_state:
    "The account balance changed. Refresh and try again.",
  proof_generation_failed: "Couldn't prepare the private payment. Try again.",
  reveal_risk_not_acknowledged:
    "Confirm that you understand this withdrawal can be linked to a payment.",
  credit_counter_mismatch:
    "A payment arrived while we were updating your balance. Try again.",
  key_already_enrolled: "This wallet is already set up.",
  transaction_not_finalized: "Waiting for the network to confirm.",
  transaction_failed: "The network rejected the transaction.",
  transaction_mismatch: "The transaction changed after it was prepared.",
  transfer_already_confirmed: "This payment was already confirmed.",
  transfer_requires_devnet: "Payments only work on devnet for now.",
  auth_unavailable: "Sign-in is unavailable right now. Try again shortly.",
  rpc_unavailable: "The network is busy. Try again shortly.",
  transfer_timeout: "That took too long. Try again.",
  network_error: "Can't reach Cadence. Check your connection.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  transfer_rate_limited: "Too many payments at once. Wait a moment.",
  wrap_rate_limited: "Too many deposits at once. Wait a moment.",
  internal_error: "Something went wrong on our side. Try again.",
  insufficient_usdc: "There isn't enough USDC for that.",
  wrap_already_confirmed: "This deposit was already confirmed.",
  invalid_wallet: "That wallet address isn't valid.",
  invalid_account: "That account isn't valid.",
  invalid_balance_key: "Your balance key isn't valid. Try again.",
  invalid_signature: "The signature wasn't accepted. Try again.",
  invalid_transfer: "That payment isn't valid.",
  invalid_confidential_setup:
    "The setup for private payments isn't valid. Try again.",
  wrap_requires_devnet: "Deposits only work on devnet for now.",
  wrapped_mint_missing: "Private payments aren't available yet.",
  usdc_source_missing: "There's no USDC account to deposit from.",
  confidential_destination_unavailable:
    "The recipient can't receive private payments yet.",
}

export function messageFor(error: unknown) {
  if (isApiError(error)) {
    return (
      (Object.hasOwn(messages, error.code)
        ? messages[error.code]
        : undefined) ??
      (error.status >= 500
        ? "Cadence is unavailable right now. Try again shortly."
        : "Something went wrong. Try again.")
    )
  }
  return "Something went wrong. Try again."
}
