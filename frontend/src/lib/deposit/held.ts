// A wrap that was sent and whose outcome cannot be told (the service no longer has it,
// answered nothing readable, or no signature came back) stays held, like a withdrawal: its
// record is kept, in every tab, and no new wrap is sent until the person releases it.

// How long it must have been unresolved before the person is offered to let it go: long
// enough for its blockhash to have run out and for the service to have been asked more than
// once. The same two minutes as a withdrawal.
export const releaseAfterMs = 2 * 60_000

// What the confirmation says plainly before the hold is released.
export const releaseWarning =
  "The earlier deposit may still have been sent. Releasing it lets a new deposit go out, and if the first one did go through you would deposit twice. Release it only after checking both balances and your history."

export const heldMessage =
  "We couldn't tell whether your last deposit went through. A new one waits until you have checked both balances above and your history, and released this one."

// Offered once the wrap has been unresolved for two minutes.
export const canRelease = (record: { at: number }, now: number) =>
  now - record.at >= releaseAfterMs
