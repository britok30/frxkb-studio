"use client";

import { useEffect, useTransition } from "react";
import { useRouter, usePathname } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { ease } from "@/lib/motion";
import { SkyCanvas } from "@/components/sky-canvas";

export function SignInClient({
  action,
  errorMessage,
}: {
  action: () => Promise<void>;
  errorMessage: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  // Surface auth errors as a toast, then strip the ?error param from the URL so
  // a refresh doesn't keep firing it.
  useEffect(() => {
    if (!errorMessage) return;
    toast.error("Sign-in didn't go through", { description: errorMessage });
    router.replace(pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorMessage]);

  function onSubmit(_formData: FormData) {
    const toastId = toast.loading("Redirecting to Google…");
    startTransition(async () => {
      try {
        await action();
        // If signIn() resolves without redirecting, that's actually unexpected.
        toast.dismiss(toastId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        toast.error("Couldn't reach Google", { id: toastId, description: msg });
      }
    });
  }

  return (
    <main className="min-h-screen grid grid-cols-1 lg:grid-cols-2">
      {/* Canvas column */}
      <div className="relative h-72 lg:h-screen lg:sticky lg:top-0 overflow-hidden">
        <SkyCanvas preset="sunset" className="absolute inset-0" />
      </div>

      {/* Form column */}
      <div className="flex items-center justify-center px-6 py-16 lg:py-0">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease, delay: 0.1 }}
          className="w-full max-w-sm flex flex-col gap-8"
        >
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold tracking-tight">
              frxkb&nbsp;<span className="text-muted-foreground font-normal">studio</span>
            </span>
            <h1 className="text-3xl font-semibold tracking-tight leading-[1.05]">
              Sign in to the studio.
            </h1>
            <p className="text-sm text-muted-foreground tracking-tight">
              Allowlisted accounts only — no self-serve.
            </p>
          </div>

          <form action={onSubmit}>
            <motion.button
              type="submit"
              disabled={pending}
              whileTap={pending ? undefined : { scale: 0.98 }}
              transition={{ duration: 0.12 }}
              className="w-full h-11 rounded-md bg-foreground text-background text-sm font-medium tracking-tight hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-opacity inline-flex items-center justify-center gap-2"
            >
              {pending ? "Redirecting…" : "Continue with Google"}
              {!pending && <span aria-hidden className="text-base leading-none">→</span>}
            </motion.button>
          </form>
        </motion.div>
      </div>
    </main>
  );
}
