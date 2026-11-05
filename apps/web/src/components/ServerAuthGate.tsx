import type { AuthSessionState } from "@t3tools/contracts";
import { useState, type FormEvent } from "react";

import {
  resolveInitialServerAuthGateState,
  submitServerAuthCredential,
} from "../environments/primary";
import { useTranslation } from "../i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { StandalonePage, StandalonePageHeader } from "./ui/standalone-page";

export function ServerAuthGate({
  auth,
  errorMessage,
  onAuthenticated,
}: {
  readonly auth: AuthSessionState["auth"];
  readonly errorMessage?: string;
  readonly onAuthenticated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [credential, setCredential] = useState("");
  const [error, setError] = useState(errorMessage);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      if (auth.loginMode === "password") {
        await submitServerAuthCredential(credential);
      } else {
        const state = await resolveInitialServerAuthGateState();
        if (state.status !== "authenticated") {
          throw new Error(state.errorMessage ?? t("Authentication failed."));
        }
      }
      setCredential("");
      await onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Authentication failed."));
    }
    setSubmitting(false);
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={t("Sign in to Cox")}
        description={
          auth.loginMode === "password" ? t("Enter your server password to continue.") : undefined
        }
      />
      <form className="mt-6 flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {auth.loginMode === "password" ? (
          <label className="flex flex-col gap-2 text-sm">
            {t("Password")}
            <Input
              type="password"
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              disabled={submitting}
              required
            />
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={submitting || (auth.loginMode === "password" && !credential.trim())}
        >
          {submitting ? t("Signing in…") : t("Sign in")}
        </Button>
      </form>
    </StandalonePage>
  );
}
