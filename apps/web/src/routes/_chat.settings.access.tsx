import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/access")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/diagnostics", replace: true });
  },
});
