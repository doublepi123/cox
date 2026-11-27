export type PreviewUnlock = { readonly type: "unlock"; readonly password: string };
export type PreviewPassword = { readonly type: "password"; readonly incorrect: boolean };

// Keep the encrypted input in the worker while the form is open. A retry only sends the password.
export function previewUnlock<Request extends { type: string }>(
  open: (request: Request, password?: string) => Promise<void>,
  reply: (result: PreviewPassword | { type: "error"; message: string }) => void,
  fallback: string,
) {
  let locked: Request | undefined;
  let working = false;
  return async (request: Request | PreviewUnlock) => {
    const input = request.type === "unlock" ? locked : (request as Request);
    if (!input || (input.type === "open" && working)) return;
    if (input.type === "open") working = true;
    try {
      await open(input, "password" in request ? request.password : undefined);
      if (input.type === "open") locked = undefined;
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
      if (code === "password-required" || code === "password-incorrect") {
        locked = input;
        reply({ type: "password", incorrect: code === "password-incorrect" });
      } else {
        if (input.type === "open") locked = undefined;
        reply({ type: "error", message: cause instanceof Error ? cause.message : fallback });
      }
    } finally {
      if (input.type === "open") working = false;
    }
  };
}
