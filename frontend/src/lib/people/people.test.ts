import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import { deriveActivation } from "./activation"
import { readAllAmounts } from "./amounts"
import { removeDescription, shortName } from "./display"
import {
  AmountNotSavedError,
  DuplicateEmailError,
  PeopleStoreError,
  PersonNotFoundError,
  inviteMessageFor,
  isRetryablePeopleError,
  peopleMessageFor,
} from "./errors"
import type { PeopleRepository } from "./repository"
import { dollarsToUnits, personFieldsSchema } from "./schema"
import { savePerson, sendInvite } from "./service"

const now = Date.parse("2026-10-04T12:00:00Z")

type Page = Awaited<ReturnType<Parameters<typeof readAllAmounts>[0]>>

describe("deriveActivation", () => {
  it("is active for an active person, whatever the invite says", () => {
    expect(deriveActivation("active", null, now)).toBe("active")
    expect(deriveActivation("active", "2020-01-01T00:00:00Z", now)).toBe(
      "active",
    )
  })

  it("is not-invited for a pending person without an invite", () => {
    expect(deriveActivation("pending", null, now)).toBe("not-invited")
  })

  it("is invited while the invite has time left", () => {
    expect(deriveActivation("pending", "2026-10-05T12:00:00Z", now)).toBe(
      "invited",
    )
  })

  it("is invite-expired at the expiry instant and after it", () => {
    expect(deriveActivation("pending", "2026-10-04T12:00:00Z", now)).toBe(
      "invite-expired",
    )
    expect(deriveActivation("pending", "2026-10-01T12:00:00Z", now)).toBe(
      "invite-expired",
    )
  })

  it("never reads an unreadable expiry as a live invite", () => {
    expect(deriveActivation("pending", "soon", now)).toBe("invite-expired")
  })
})

describe("dollarsToUnits", () => {
  it.each([
    [4200, "4200000000"],
    [4200.5, "4200500000"],
    [0.01, "10000"],
    [19.99, "19990000"],
    [0.29, "290000"],
    [281_474_976, "281474976000000"],
  ])("converts %s dollars exactly", (dollars, units) => {
    expect(dollarsToUnits(dollars)).toBe(units)
  })
})

describe("personFieldsSchema", () => {
  it("validates everything but the amount", () => {
    expect(
      personFieldsSchema.safeParse({
        name: "Bruno",
        email: "bruno@solaris.test",
        kind: "employee",
      }).success,
    ).toBe(true)
    expect(
      personFieldsSchema.safeParse({
        name: " ",
        email: "bruno@solaris.test",
        kind: "employee",
      }).success,
    ).toBe(false)
  })
})

describe("readAllAmounts", () => {
  it("follows the cursor to the last page", async () => {
    const pages: Record<string, Page> = {
      first: {
        items: [{ person_id: "a", amount: "1" }],
        next_cursor: "50",
      },
      "50": {
        items: [{ person_id: "b", amount: "2" }],
        next_cursor: null,
      },
    }
    const fetchPage = vi.fn(async (cursor?: string) => pages[cursor ?? "first"])
    expect(await readAllAmounts(fetchPage)).toEqual({ a: "1", b: "2" })
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      "50",
    ])
  })

  it("stops on a cursor that does not move", async () => {
    const fetchPage = vi.fn(async () => ({
      items: [{ person_id: "a", amount: "1" }],
      next_cursor: "same",
    }))
    await readAllAmounts(fetchPage)
    // First page, then the repeated cursor once; never an endless loop.
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it("is empty for a company without amounts", async () => {
    expect(
      await readAllAmounts(async () => ({ items: [], next_cursor: null })),
    ).toEqual({})
  })
})

describe("display", () => {
  it("keeps a short name and cuts a long one with an ellipsis", () => {
    expect(shortName("Bruno Costa")).toBe("Bruno Costa")
    const cut = shortName("x".repeat(200))
    expect(Array.from(cut)).toHaveLength(40)
    expect(cut.endsWith("…")).toBe(true)
  })

  it("does not split a character in two", () => {
    expect(shortName("😀".repeat(50))).toBe(`${"😀".repeat(39)}…`)
  })

  it("mentions the pending invite only when there is one", () => {
    expect(removeDescription("invited")).toContain("pending invite")
    expect(removeDescription("invite-expired")).toContain("pending invite")
    expect(removeDescription("active")).not.toContain("pending invite")
    expect(removeDescription("not-invited")).not.toContain("pending invite")
  })
})

describe("messages", () => {
  it("gives each invite conflict its own copy", () => {
    expect(
      inviteMessageFor(new ApiError(409, "person_already_active")),
    ).toMatch(/already has an account/)
    expect(inviteMessageFor(new ApiError(409, "person_removed"))).toMatch(
      /removed/,
    )
    expect(inviteMessageFor(new ApiError(404, "person_not_found"))).toMatch(
      /no longer on your list/,
    )
  })

  it("falls back to the shared copy for any other code", () => {
    expect(inviteMessageFor(new ApiError(502, "internal_error"))).toMatch(
      /on our side/,
    )
    expect(inviteMessageFor(new Error("boom: secret"))).not.toMatch(/secret/)
  })

  it("calls any rate limit on an invite a limit on invites", () => {
    for (const code of ["transfer_rate_limited", "rate_limited"]) {
      expect(inviteMessageFor(new ApiError(429, code))).toMatch(
        /Too many invites/,
      )
    }
  })

  it("never shows the store's own message", () => {
    expect(peopleMessageFor(new PeopleStoreError())).not.toMatch(/people_store/)
    expect(peopleMessageFor(new DuplicateEmailError())).toMatch(/email/)
    expect(peopleMessageFor(new PersonNotFoundError())).toMatch(/no longer/)
  })

  it("says the person was saved when only the amount failed", () => {
    const message = peopleMessageFor(
      new AmountNotSavedError(new ApiError(503, "auth_unavailable")),
    )
    expect(message).toMatch(/^Saved, but the monthly amount wasn't/)
  })

  it("offers a retry for a busy service, not for a half-done create", () => {
    expect(isRetryablePeopleError(new ApiError(429, "rate_limited"))).toBe(true)
    expect(isRetryablePeopleError(new PeopleStoreError())).toBe(true)
    expect(isRetryablePeopleError(new ApiError(409, "person_removed"))).toBe(
      false,
    )
    expect(
      isRetryablePeopleError(
        new AmountNotSavedError(new ApiError(429, "rate_limited")),
      ),
    ).toBe(false)
  })
})

function fakeRepository() {
  return {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "new-id" })),
    update: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    recordInvite: vi.fn(async () => {}),
  } satisfies PeopleRepository
}

const input = {
  name: "Diego",
  email: "diego@martins.test",
  kind: "contractor",
} as const

describe("savePerson", () => {
  it("creates the person, then sets the amount on the new id", async () => {
    const repository = fakeRepository()
    const setAmount = vi.fn(async () => ({}))
    const result = await savePerson(
      { repository, setAmount },
      { input, amount: "6300000000" },
    )
    expect(result).toEqual({ id: "new-id", inviteStale: false })
    expect(repository.create).toHaveBeenCalledWith(input)
    expect(setAmount).toHaveBeenCalledWith("new-id", "6300000000")
    expect(repository.create.mock.invocationCallOrder[0]).toBeLessThan(
      setAmount.mock.invocationCallOrder[0],
    )
  })

  it("never sends the amount to the table", async () => {
    const repository = fakeRepository()
    await savePerson(
      { repository, setAmount: async () => ({}) },
      { input, amount: "6300000000" },
    )
    expect(JSON.stringify(repository.create.mock.calls)).not.toMatch(/6300/)
  })

  it("skips the proof service when the amount is left alone", async () => {
    const repository = fakeRepository()
    const setAmount = vi.fn(async () => ({}))
    await savePerson({ repository, setAmount }, { id: "p1", input })
    expect(repository.update).toHaveBeenCalledWith("p1", input)
    expect(setAmount).not.toHaveBeenCalled()
  })

  it("does not touch the amount when the person cannot be saved", async () => {
    const repository = fakeRepository()
    repository.create.mockRejectedValueOnce(new DuplicateEmailError())
    const setAmount = vi.fn(async () => ({}))
    await expect(
      savePerson({ repository, setAmount }, { input, amount: "1" }),
    ).rejects.toBeInstanceOf(DuplicateEmailError)
    expect(setAmount).not.toHaveBeenCalled()
  })

  it("reports a saved person whose amount failed", async () => {
    const repository = fakeRepository()
    const failure = new ApiError(404, "person_not_found")
    const error = await savePerson(
      {
        repository,
        setAmount: async () => {
          throw failure
        },
      },
      { input, amount: "1" },
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AmountNotSavedError)
    expect((error as AmountNotSavedError).reason).toBe(failure)
    expect(repository.create).toHaveBeenCalledTimes(1)
  })

  it("flags an invite as stale only when the address it went to changed", async () => {
    const run = (invitedEmail?: string, email = input.email) =>
      savePerson(
        { repository: fakeRepository(), setAmount: async () => ({}) },
        { id: "p1", input: { ...input, email }, invitedEmail },
      )
    expect((await run("diego@other.test")).inviteStale).toBe(true)
    expect((await run("DIEGO@martins.test")).inviteStale).toBe(false)
    expect((await run(undefined)).inviteStale).toBe(false)
  })
})

describe("sendInvite", () => {
  it("records the expiry the service answered with", async () => {
    const repository = fakeRepository()
    await sendInvite(
      {
        repository,
        invite: async () => ({ expires_at: "2026-10-11T12:00:00Z" }),
      },
      "p1",
    )
    expect(repository.recordInvite).toHaveBeenCalledWith(
      "p1",
      "2026-10-11T12:00:00Z",
    )
  })

  it("records nothing when the send fails", async () => {
    const repository = fakeRepository()
    await expect(
      sendInvite(
        {
          repository,
          invite: async () => {
            throw new ApiError(409, "person_already_active")
          },
        },
        "p1",
      ),
    ).rejects.toMatchObject({ code: "person_already_active" })
    expect(repository.recordInvite).not.toHaveBeenCalled()
  })
})
