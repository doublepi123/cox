import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["http", "https"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(
        providerAuthReturnUrl(`${scheme}://localhost/welcome?code=secret#agents:machine-id`),
      ).toBe(`${scheme}://localhost/welcome#agents:machine-id`);
      expect(
        providerAuthReturnUrl(
          `${scheme}://localhost/settings/providers?instanceId=work&code=secret`,
        ),
      ).toBe(`${scheme}://localhost/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "t3code://attacker/welcome",
    "t3code://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
