// Console errors that are known and not this suite's to fix, each with the reason and what
// removes it. Keep this list short: an entry is a bug somebody else owns. Each entry names
// a `probe`, a path whose answer says whether the noise can still happen, and
// `known-noise.spec.ts` fails once it cannot, so an entry never outlives its cause.
export type KnownNoise = {
  status: number
  url: RegExp
  why: string
  // The noise is a failed request for this path. While it answers `status`, the
  // entry is needed; when it does not, delete the entry.
  probe: string
}

export const knownNoise: KnownNoise[] = [
  {
    // The recipient's sidebar links to /me/history, which the recipient screens task (H)
    // adds. Next prefetches the link, and the missing route logs a 404.
    status: 404,
    url: /\/me\/history(\?|$)/,
    why: "/me/history does not exist yet (task H)",
    probe: "/me/history",
  },
]
