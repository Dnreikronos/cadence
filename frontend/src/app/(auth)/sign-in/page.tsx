import { AuthPage, type AuthSearchParams } from "../auth-page"

export default function SignIn({
  searchParams,
}: {
  searchParams: AuthSearchParams
}) {
  return <AuthPage mode="sign-in" searchParams={searchParams} />
}
