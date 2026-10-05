import { z } from "zod"

// zod 4 compiles object parsers with `new Function` and probes once, with a try/catch,
// whether that is allowed. Under a CSP without `unsafe-eval` the throw is swallowed but
// the browser still reports a `securitypolicyviolation`. `jitless` skips the probe and
// uses the interpreted parsers, which are what a blocked probe fell back to anyway.
// It has to be set before the first schema is built, so the browser loads this through
// src/instrumentation-client.ts, which runs ahead of every other client module.
z.config({ jitless: true })
