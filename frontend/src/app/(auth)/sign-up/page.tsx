import type { Metadata } from "next"
import { AuthPage, type AuthSearchParams } from "../auth-page"

export const metadata: Metadata = { title: "Create your company" }

// An admin signs up by creating their company; recipients and auditors join by invite.
export default function SignUp({
  searchParams,
}: {
  searchParams: AuthSearchParams
}) {
  return <AuthPage mode="sign-up" searchParams={searchParams} />
}
