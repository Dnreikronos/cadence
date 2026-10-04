// `pnpm e2e:build`: the production build the e2e suite serves, in demo mode, and a marker
// beside it saying so (see demo-env.cjs). CI runs this, then `E2E_SKIP_BUILD=1 pnpm e2e`.
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { demoEnv, markerFile, markerFor } from "./demo-env.cjs"

// A marker from an earlier build must not vouch for this one if it fails.
rmSync(markerFile, { force: true })

const build = spawnSync("pnpm", ["exec", "next", "build"], {
  stdio: "inherit",
  env: { ...process.env, ...demoEnv },
})
if (build.status !== 0) process.exit(build.status ?? 1)

mkdirSync(path.dirname(markerFile), { recursive: true })
writeFileSync(markerFile, JSON.stringify(markerFor(demoEnv)))
