import { z } from "zod"
import { ApiError, ContractError, errorFromResponse } from "./errors"
import * as s from "./schemas"

export type ApiClientOptions = {
  baseUrl: string
  // The Supabase access token, or null when signed out.
  getToken: () => Promise<string | null>
  fetch?: typeof fetch
}

// Per-call options. `signal` cancels the request (the fetch rejects with the
// abort reason, which is not an ApiError).
export type RequestOptions = { signal?: AbortSignal }

type CallOptions<T extends z.ZodType> = RequestOptions & {
  method?: "GET" | "POST" | "PUT" | "DELETE"
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
    const {
      method = "GET",
      body: makeBody,
      query,
      auth = true,
      signal,
    } = options
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
        signal,
      })
    } catch (error) {
      // fetch rejects with a TypeError when it cannot reach the server. Anything
      // else (an abort, a mock that failed to start) is not a network problem.
      if (error instanceof TypeError) throw new ApiError(0, "network_error")
      throw error
    }
    return response
  }

  const readJson = (response: Response) =>
    response.json().catch(() => undefined) as Promise<unknown>

  async function call<T extends z.ZodType>(
    path: string,
    options: CallOptions<T>,
  ): Promise<z.output<T>> {
    const response = await send(path, options)
    const body = await readJson(response)
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

  async function download(path: string, options: RequestOptions) {
    const response = await send(path, options)
    if (!response.ok) {
      throw errorFromResponse(response, await readJson(response))
    }
    // A proxy's HTML page with a 200 must not be saved as the export.
    const type = response.headers.get("content-type") ?? ""
    if (!/^text\/csv\b/i.test(type)) {
      throw new ContractError(path, "expected a text/csv response")
    }
    return response.blob()
  }

  // Ids go into the path, so only a guid may: ".." or "/" must never reach it.
  const segment = (value: string) => s.idSchema.parse(value)

  return {
    // A 503 carries the health body (`unavailable`), so it is returned, not thrown.
    health: async (options: RequestOptions = {}) => {
      const response = await send("/health", { ...options, auth: false })
      const body = await readJson(response)
      if (response.ok || response.status === 503) {
        const parsed = s.healthSchema.safeParse(body)
        if (parsed.success) return parsed.data
        if (response.ok) {
          throw new ContractError("/health", z.prettifyError(parsed.error))
        }
      }
      throw errorFromResponse(response, body)
    },

    wrap: {
      prepare: (request: s.WrapRequest, options: RequestOptions = {}) =>
        call("/wrap", {
          ...options,
          method: "POST",
          body: body(s.wrapRequestSchema, request),
          response: s.wrapPreparedSchema,
        }),
      confirm: (request: s.ConfirmRequest, options: RequestOptions = {}) =>
        call("/wrap/confirm", {
          ...options,
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
    },

    transfer: {
      prepare: (request: s.TransferRequest, options: RequestOptions = {}) =>
        call("/transfer", {
          ...options,
          method: "POST",
          body: body(s.transferRequestSchema, request),
          response: s.transferPreparedSchema,
        }),
      confirm: (request: s.ConfirmRequest, options: RequestOptions = {}) =>
        call("/transfer/confirm", {
          ...options,
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
    },

    runs: {
      create: (request: s.RunRequest, options: RequestOptions = {}) =>
        call("/runs", {
          ...options,
          method: "POST",
          body: body(s.runRequestSchema, request),
          response: s.runCreatedSchema,
        }),
      get: async (runId: string, options: RequestOptions = {}) =>
        call(`/runs/${segment(runId)}`, { ...options, response: s.runSchema }),
      confirmPayment: async (
        runId: string,
        paymentId: string,
        signature: string,
        options: RequestOptions = {},
      ) =>
        call(`/runs/${segment(runId)}/payments/${segment(paymentId)}/confirm`, {
          ...options,
          method: "POST",
          body: body(s.paymentConfirmSchema, { signature }),
          response: s.receiptSchema,
        }),
      retryPayment: async (
        runId: string,
        paymentId: string,
        options: RequestOptions = {},
      ) =>
        call(`/runs/${segment(runId)}/payments/${segment(paymentId)}/retry`, {
          ...options,
          method: "POST",
          response: s.runPaymentPreparedSchema,
        }),
    },

    unwrap: {
      prepare: (request: s.UnwrapRequest, options: RequestOptions = {}) =>
        call("/unwrap", {
          ...options,
          method: "POST",
          body: body(s.unwrapRequestSchema, request),
          response: s.unwrapPreparedSchema,
        }),
      confirm: (request: s.ConfirmRequest, options: RequestOptions = {}) =>
        call("/unwrap/confirm", {
          ...options,
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
    },

    accounts: {
      configure: (wallet: string, options: RequestOptions = {}) =>
        call("/accounts/configure", {
          ...options,
          method: "POST",
          body: body(s.walletRequestSchema, { wallet }),
          response: s.preparedSchema,
        }),
      confirmConfigure: (
        request: s.ConfirmRequest,
        options: RequestOptions = {},
      ) =>
        call("/accounts/configure/confirm", {
          ...options,
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
      applyPending: (wallet: string, options: RequestOptions = {}) =>
        call("/accounts/apply-pending", {
          ...options,
          method: "POST",
          body: body(s.walletRequestSchema, { wallet }),
          response: s.preparedSchema,
        }),
      confirmApplyPending: (
        request: s.ConfirmRequest,
        options: RequestOptions = {},
      ) =>
        call("/accounts/apply-pending/confirm", {
          ...options,
          method: "POST",
          body: body(s.confirmRequestSchema, request),
          response: s.receiptSchema,
        }),
    },

    keys: {
      enroll: (
        wallet: string,
        signature: string,
        options: RequestOptions = {},
      ) =>
        call("/keys/enroll", {
          ...options,
          method: "POST",
          body: body(s.enrollRequestSchema, { wallet, signature }),
          response: s.enrolledSchema,
        }),
    },

    me: {
      balance: (options: RequestOptions = {}) =>
        call("/me/balance", { ...options, response: s.balanceSchema }),
      payments: (query: PageQuery = {}, options: RequestOptions = {}) =>
        call("/me/payments", {
          ...options,
          query,
          response: page(s.paymentItemSchema),
        }),
      // Whether activation can resume where it stopped. No amount, no audit row.
      status: (options: RequestOptions = {}) =>
        call("/me/status", { ...options, response: s.accountStatusSchema }),
    },

    company: {
      balance: (options: RequestOptions = {}) =>
        call("/company/balance", { ...options, response: s.balanceSchema }),
      payments: (query: PageQuery = {}, options: RequestOptions = {}) =>
        call("/company/payments", {
          ...options,
          query,
          response: page(s.paymentItemSchema),
        }),
      amounts: (query: PageQuery = {}, options: RequestOptions = {}) =>
        call("/company/people/amounts", {
          ...options,
          query,
          response: page(s.personAmountSchema),
        }),
      setAmount: async (
        personId: string,
        amount: string,
        options: RequestOptions = {},
      ) =>
        call(`/company/people/${segment(personId)}/amount`, {
          ...options,
          method: "PUT",
          body: body(s.setAmountRequestSchema, { amount }),
          response: s.personAmountSchema,
        }),
      invite: async (personId: string, options: RequestOptions = {}) =>
        call(`/company/people/${segment(personId)}/invite`, {
          ...options,
          method: "POST",
          response: s.inviteSchema,
        }),
      // Who may read every payment amount. Admin only; never carries an amount.
      auditors: {
        list: (query: PageQuery = {}, options: RequestOptions = {}) =>
          call("/company/auditors", {
            ...options,
            query,
            response: page(s.auditorSchema),
          }),
        invite: (email: string, options: RequestOptions = {}) =>
          call("/company/auditors", {
            ...options,
            method: "POST",
            body: body(s.inviteAuditorRequestSchema, { email }),
            response: s.auditorSchema,
          }),
        revoke: async (auditorId: string, options: RequestOptions = {}) =>
          call(`/company/auditors/${segment(auditorId)}`, {
            ...options,
            method: "DELETE",
            response: s.auditorRevokedSchema,
          }),
      },
    },

    audit: {
      payments: async (
        companyId: string,
        query: PageQuery = {},
        options: RequestOptions = {},
      ) =>
        call(`/audit/${segment(companyId)}/payments`, {
          ...options,
          query,
          response: page(s.paymentItemSchema),
        }),
      // Who decrypted what for the company the auditor audits, newest first.
      accessLog: (query: PageQuery = {}, options: RequestOptions = {}) =>
        call("/audit/access-log", {
          ...options,
          query,
          response: page(s.accessLogItemSchema),
        }),
    },

    // CSV needs the bearer header, so it is fetched and saved as a Blob.
    exports: {
      company: (options: RequestOptions = {}) =>
        download("/company/export.csv", options),
      me: (options: RequestOptions = {}) => download("/me/export.csv", options),
      audit: async (companyId: string, options: RequestOptions = {}) =>
        download(`/audit/${segment(companyId)}/export.csv`, options),
    },
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
