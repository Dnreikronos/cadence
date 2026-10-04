import { signInAs } from "./support/demo"
import { knownNoise } from "./support/known-noise"
import { expect, test } from "./support/test"

// The console watch lets the entries of `knownNoise` through. This keeps them honest: the
// day the thing they wait for exists, the entry is stale and the suite says so.
for (const noise of knownNoise) {
  test(`the known console noise for ${noise.probe} is still real`, async ({
    page,
  }) => {
    await signInAs(page, "recipient")

    const response = await page.request.get(noise.probe, {
      maxRedirects: 0,
    })

    expect(
      response.status(),
      `${noise.probe} now answers ${response.status()}, not ${noise.status}: ${noise.why} is over. ` +
        "Delete its entry from e2e/support/known-noise.ts.",
    ).toBe(noise.status)
  })
}
