import "@turnkey/react-wallet-kit/styles.css"
import { Providers } from "./providers"

export const metadata = { title: "Embedded wallet spike" }

export default function Layout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", maxWidth: 760, margin: "24px auto", padding: "0 16px" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
