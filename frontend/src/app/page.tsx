import Link from "next/link";
import { Placeholder } from "@/components/app/placeholder";

export default function Home() {
  return (
    <Placeholder title="Cadence">
      <p>Pay your team in USDC without showing the amounts to the world.</p>
      <p className="mt-4">
        <Link href="/sign-in" className="underline">
          Sign in
        </Link>
      </p>
    </Placeholder>
  );
}
