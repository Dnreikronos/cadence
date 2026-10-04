import type { Submission } from "@/lib/submissions"

// What sessionStorage is to the app, so a test can look at what was kept.
export function memoryStore(initial: Submission | null = null) {
  let saved = initial
  return {
    read: () => saved,
    record: (record: Omit<Submission, "at"> & { at?: number }) =>
      (saved = { ...record, at: record.at ?? 0 }),
    clear: () => {
      saved = null
    },
  }
}
