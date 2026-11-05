import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";

import {
  ThreadErrorBanner,
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  getThreadErrorBannerMessage,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("getThreadErrorBannerMessage", () => {
  it("extracts a readable nested message without trimming its whitespace", () => {
    const message =
      "  This model is not supported with a ChatGPT account.\nChoose another model.  ";
    const error = ` \n${JSON.stringify({ error: { message, code: "unsupported_model" } })}\t `;

    expect(getThreadErrorBannerMessage(error)).toBe(message);
  });

  it("keeps the diagnostics when the nested message is blank", () => {
    const error = JSON.stringify({ error: { message: " \n\t ", code: "unsupported_model" } });

    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });
});

describe("ThreadErrorBanner", () => {
  it("shows the ChatGPT usage action without redundant personal-limit instructions", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Usage limit" errorCode={CHATGPT_USAGE_LIMIT_CODE} />,
    );
    expect(markup).toContain("ChatGPT usage limit reached");
    expect(markup).toContain("Manage usage");
    expect(markup).not.toContain("Review your usage settings in ChatGPT.");
  });

  it("keeps workspace-admin guidance on legacy sharing errors", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Usage limit" errorCode={CHATGPT_WORKSPACE_USAGE_LIMIT_CODE} />,
    );
    expect(markup).toContain("workspace admin");
    expect(markup).toContain("Copy request for admin");
    expect(markup).not.toContain("Manage usage");
  });

  it("reappears for different diagnostics with the same headline on the same thread", () => {
    const firstError = JSON.stringify({ error: { message: "Turn failed", code: "first" } });
    const secondError = JSON.stringify({ error: { message: "Turn failed", code: "second" } });
    const dismissedKey = getThreadErrorBannerKey("env:thread-b", firstError);
    dismissThreadErrorBannerForSession(dismissedKey);
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", secondError);

    expect(isThreadErrorBannerDismissedForSession(dismissedKey)).toBe(true);
    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        secondError,
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });
});
