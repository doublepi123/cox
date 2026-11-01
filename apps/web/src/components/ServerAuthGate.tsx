import type { AuthSessionState } from "@t3tools/contracts";
import { useState, type FormEvent } from "react";

import { submitServerAuthCredential } from "../environments/primary";
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
  const credentialLabel = auth.passwordLogin ? t("Password or pairing token") : t("Pairing token");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await submitServerAuthCredential(credential);
      setCredential("");
      await onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Authentication failed."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={t("Sign in to Cox")}
        description={t(
          "Enter the pairing token from the server terminal, or open its pairing URL.",
        )}
      />
      <form className="mt-6 flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <label className="flex flex-col gap-2 text-sm">
          {credentialLabel}
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
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={submitting || !credential.trim()}>
          {submitting ? t("Signing in…") : t("Sign in")}
        </Button>
      </form>
    </StandalonePage>
  );
}
