import { expect, test } from "./support/test"

// The suite runs against `next start`, a production build, so the /dev pages must be off
// (NEXT_PUBLIC_DEV_TOOLS is not set): they show fake data and need no session.
test("the /dev pages answer 404 in a production build, however they are spelled", async ({
  request,
}) => {
  for (const path of [
    "/dev",
    "/dev/",
    "/dev/api",
    "/dev/components",
    "/dev/components/shell/admin",
    "/dev/screens/people",
    "/%64ev/api",
    "/DEV/api",
  ]) {
    // Followed: Next first sends "/dev/" to "/dev" with a 308.
    const response = await request.get(path)
    expect(response.status(), path).toBe(404)
  }
})

test("a page that only looks like /dev, and the guarded areas, are unaffected", async ({
  request,
}) => {
  // Nothing lives at /devices: the app's own 404, not the /dev rule.
  expect((await request.get("/devices")).status()).toBe(404)
  // A guarded area still sends a visitor to sign-in, remembering where they were going.
  const guarded = await request.get("/company", { maxRedirects: 0 })
  expect(guarded.status()).toBe(307)
  expect(guarded.headers().location).toContain("/sign-in?next=%2Fcompany")
  expect((await request.get("/sign-in")).status()).toBe(200)
})
