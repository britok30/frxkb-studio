import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { SignInClient } from "./signin-client";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  const params = await searchParams;

  // Already signed in → bounce home.
  if (session?.user) redirect(params.callbackUrl ?? "/");

  async function continueWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: params.callbackUrl ?? "/" });
  }

  const errorMessage = params.error
    ? params.error === "AccessDenied"
      ? "That email isn't on the studio's allowlist."
      : "Sign-in didn't go through. Try again."
    : null;

  return <SignInClient action={continueWithGoogle} errorMessage={errorMessage} />;
}
