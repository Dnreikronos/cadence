import type { NextConfig } from "next"
import { headerRules } from "./src/lib/security-headers"

const nextConfig: NextConfig = {
  async headers() {
    return headerRules()
  },
  webpack(config, { isServer }) {
    // msw/browser is not exported for the `node` condition, and the mock API only
    // ever starts in the browser. The server build gets an empty module.
    if (isServer) {
      config.resolve.alias = { ...config.resolve.alias, "msw/browser": false }
    }
    return config
  },
}

export default nextConfig
