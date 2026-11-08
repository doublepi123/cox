import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { SecretRequestItem } from "@t3tools/client-runtime/secret-request";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { SecretRequestCard } from "./SecretRequestCard";

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: () => vi.fn().mockResolvedValue({ _tag: "Success" }),
}));

it("uses a native password input so masking also applies to assistive technologies", async () => {
  const item = {
    id: TurnItemId.make("secret-card-test"),
    threadId: ThreadId.make("secret-thread-test"),
    type: "secret_request",
    secretStatus: "pending",
    label: "API token",
    reason: "Configure the service",
  } as SecretRequestItem;
  await using screen = await render(
    <SecretRequestCard
      environmentId={EnvironmentId.make("local")}
      item={item}
      visibility="local"
    />,
  );
  const input = screen.container.querySelector("input");
  expect(input?.type).toBe("password");
  expect(input?.autocomplete).toBe("off");
  expect(input?.className).not.toContain("text-security");
  expect(input?.hasAttribute("data-1p-ignore")).toBe(true);
});
