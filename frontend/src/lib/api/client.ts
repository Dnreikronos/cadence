import { z } from "zod"
import { ApiError, ContractError, errorFromResponse } from "./errors"
import * as s from "./schemas"

export type ApiClientOptions = {
  baseUrl: string
  // The Supabase access token, or null when signed out.
  getToken: () => Promise<string | null>
  fetch?: typeof fetch
}

type CallOptions<T extends z.ZodType> = {
  method?: "GET" | "POST" | "PUT"
  // Evaluated inside the async call, so an invalid request rejects instead of throwing.
  body?: () => unknown
  query?: Record<string, string | number | undefined>
  response: T
  // /health is the only route without a bearer token.
  auth?: boolean
}

export type PageQuery = { limit?: number; cursor?: string }

export function createApiClient({
  baseUrl,
  getToken,
  fetch: fetchImpl,
}: ApiClientOptions) {
  const origin = baseUrl.replace(/\/+$/, "")

  async function send(
    path: string,
    options: Omit<CallOptions<z.ZodType>, "response">,
  ) {
    const { method = "GET", body: makeBody, query, auth = true } = options
    const payload = makeBody?.()
    const headers: Record<string, string> = { accept: "application/json" }
    if (auth) {
      const token = await getToken()
      if (!token) throw new ApiError(401, "authentication_required")
      headers.authorization = `Bearer ${token}`
    }
    if (payload !== undefined) headers["content-type"] = "application/json"

    const url = new URL(origin + path)
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }

    let response: Response
    try {
      response = await (fetchImpl ?? fetch)(url, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        // Responses can hold decrypted amounts: never reuse them from a cache.
        cache: "no-store",
      })
    } catch {
      throw new ApiError(0, "network_error")
    }
    return response
  }

  async function call<T extends z.ZodType>(
    path: string,
    options: CallOptions<T>,
  ): Promise<z.output<T>> {
    const response = await send(path, options)
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) throw errorFromResponse(response, body)
    const parsed = options.response.safeParse(body)
    if (!parsed.success) {
      throw new ContractError(path, z.prettifyError(parsed.error))
    }
    return parsed.data
  }

  // Validates the request against the contract before it leaves the browser.
  function body<T extends z.ZodType>(schema: T, value: z.input<T>) {
    return () => schema.parse(value)
  }

  const page = <T extends z.ZodType>(item: T) => s.pageSchema(item)

  async function download(path: string) {
    const response = await send(path, {})
    if (!response.ok) {
      throw errorFromResponse(
        response,
        await response.json().catch(() => undefined),
      )
    }
    return response.blob()
  }

  return {
    health: () => call("/health", { response: s.healthSchema, auth: false }),

    wrap: {
      prepare: (request: s.WrapRequest) =>
        call("/wrap", {
          method: "POST",
          body: body(s.wrapRequestSchema, request),
          response: s.wrapPreparedSchema,
        }),
      confirm: (request: s.ConfirmRequest) =>
        call("/wrap/confirm", {
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
    },

    transfer: {
      prepare: (request: s.TransferRequest) =>
        call("/transfer", {
          method: "POST",
          body: body(s.transferRequestSchema, request),
          response: s.transferPreparedSchema,
        }),
      confirm: (request: s.ConfirmRequest) =>
        call("/transfer/confirm", {
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
    },

    runs: {
      create: (request: s.RunRequest) =>
        call("/runs", {
          method: "POST",
          body: body(s.runRequestSchema, request),
          response: s.runCreatedSchema,
        }),
      get: (runId: string) =>
        call(`/runs/${encodeURIComponent(runId)}`, { response: s.runSchema }),
      confirmPayment: (runId: string, paymentId: string, signature: string) =>
        call(
          `/runs/${encodeURIComponent(runId)}/payments/${encodeURIComponent(paymentId)}/confirm`,
          {
            method: "POST",
            body: body(s.paymentConfirmSchema, { signature }),
            response: s.receiptSchema,
          },
        ),
      retryPayment: (runId: string, paymentId: string) =>
        call(
          `/runs/${encodeURIComponent(runId)}/payments/${encodeURIComponent(paymentId)}/retry`,
          { method: "POST", response: s.runPaymentPreparedSchema },
        ),
    },

    unwrap: {
      prepare: (request: s.UnwrapRequest) =>
        call("/unwrap", {
          method: "POST",
          body: body(s.unwrapRequestSchema, request),
          response: s.unwrapPreparedSchema,
        }),
      confirm: (request: s.ConfirmRequest) =>
        call("/unwrap/confirm", {
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
    },

    accounts: {
      configure: (wallet: string) =>
        call("/accounts/configure", {
          method: "POST",
          body: body(s.walletRequestSchema, { wallet }),
          response: s.preparedSchema,
        }),
      confirmConfigure: (request: s.ConfirmRequest) =>
        call("/accounts/configure/confirm", {
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
      applyPending: (wallet: string) =>
        call("/accounts/apply-pending", {
          method: "POST",
          body: body(s.walletRequestSchema, { wallet }),
          response: s.preparedSchema,
        }),
      confirmApplyPending: (request: s.ConfirmRequest) =>
        call("/accounts/apply-pending/confirm", {
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
    },

    keys: {
      enroll: (wallet: string, signature: string) =>
        call("/keys/enroll", {
          method: "POST",
          body: body(s.enrollRequestSchema, { wallet, signature }),
          response: s.enrolledSchema,
        }),
    },

    me: {
      balance: () => call("/me/balance", { response: s.balanceSchema }),
      payments: (query: PageQuery = {}) =>
        call("/me/payments", {
          query,
          response: page(s.paymentItemSchema),
        }),
    },

    company: {
      payments: (query: PageQuery = {}) =>
        call("/company/payments", {
          query,
          response: page(s.paymentItemSchema),
        }),
      amounts: (query: PageQuery = {}) =>
        call("/company/people/amounts", {
          query,
          response: page(s.personAmountSchema),
        }),
      setAmount: (personId: string, amount: string) =>
        call(`/company/people/${encodeURIComponent(personId)}/amount`, {
          method: "PUT",
          body: body(s.setAmountRequestSchema, { amount }),
          response: s.personAmountSchema,
        }),
      invite: (personId: string) =>
        call(`/company/people/${encodeURIComponent(personId)}/invite`, {
          method: "POST",
          response: s.inviteSchema,
        }),
    },

    audit: {
      payments: (companyId: string, query: PageQuery = {}) =>
        call(`/audit/${encodeURIComponent(companyId)}/payments`, {
          query,
          response: page(s.paymentItemSchema),
        }),
    },

    // CSV needs the bearer header, so it is fetched and saved as a Blob.
    exports: {
      company: () => download("/company/export.csv"),
      me: () => download("/me/export.csv"),
      audit: (companyId: string) =>
        download(`/audit/${encodeURIComponent(companyId)}/export.csv`),
    },
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
