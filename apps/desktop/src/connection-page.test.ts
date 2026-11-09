import { describe, expect, it } from "vite-plus/test";
import { createConnectionPage } from "./connection-page.ts";
import { createStartupPage } from "./startup-page.ts";

const profile = {
  id: "7c9f22fc-6c0e-4d5b-9a6e-0b91e6aa1a20",
  name: "Office <script>alert(1)</script>",
  origin: "https://cox.example.com",
  environmentId: "environment-1",
  label: "Build server",
  serverVersion: "0.1.56",
};

describe("local desktop connection pages", () => {
  it("escapes server metadata and contains no password field or remote script", () => {
    const page = createConnectionPage(
      "en-US",
      { active: { kind: "remote", profileId: profile.id }, profiles: [profile] },
      undefined,
      "Connection <failed>",
    );
    expect(page).toContain("Office &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("Connection &lt;failed&gt;");
    expect(page).not.toContain('type="password"');
    expect(page).toContain("form-action 'none'");
    expect(page).toContain("default-src 'none'");
    expect(page).toContain("Passwords are never saved");
  });

  it("offers connections during local backend preparation", () => {
    expect(createStartupPage("zh-CN")).toContain("连接管理");
    expect(createStartupPage("en-US")).toContain("cox-open-connections");
  });
});
