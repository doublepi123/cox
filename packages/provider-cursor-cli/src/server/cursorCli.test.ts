import { assert, describe, it } from "@effect/vitest";

import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import {
  cursorCliAcpArgs,
  cursorCliLaunchRuntimeMode,
  resolveCursorCliModelId,
} from "./acpSupport.ts";
import { parseCursorCliLoginUrl } from "./auth.ts";
import {
  cursorAskQuestions,
  cursorPlanMarkdown,
  makeCursorAskQuestionResponse,
  type CursorAskQuestionRequest,
} from "./extensions.ts";
import {
  cursorCliDownloadUrl,
  isSafeCursorCliArchiveEntry,
  parseCursorCliInstallScriptVersion,
  parseCursorCliVersion,
} from "./installation.ts";

describe("Cursor CLI launch", () => {
  it.each([
    [undefined, ["acp"]],
    ["approval-required", ["acp"]],
    ["auto", ["--auto-review", "acp"]],
    ["full-access", ["--force", "acp"]],
  ] as const)("maps runtime mode %s to CLI flags", (runtimeMode, expected) => {
    assert.deepStrictEqual(cursorCliAcpArgs({ apiEndpoint: "" }, runtimeMode), expected);
  });

  it("passes a configured endpoint before the ACP command", () => {
    assert.deepStrictEqual(cursorCliAcpArgs({ apiEndpoint: "https://api2.cursor.sh" }, "auto"), [
      "--endpoint",
      "https://api2.cursor.sh",
      "--auto-review",
      "acp",
    ]);
  });

  it("launches supervised when an explicit approval policy overrides full access", () => {
    assert.equal(
      cursorCliLaunchRuntimeMode(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/work",
          approvalPolicy: "on-request",
        }),
      ),
      "approval-required",
    );
  });

  it.each([
    [undefined, "default"],
    ["auto", "default"],
    ["grok-4.7", "grok-4.7"],
    ["claude-opus-5[thinking=true,effort=high]", "claude-opus-5"],
  ] as const)("sends model %s as %s", (model, expected) => {
    assert.equal(resolveCursorCliModelId(model), expected);
  });
});

const question: CursorAskQuestionRequest = {
  toolCallId: "call-1",
  title: "Need input",
  questions: [
    {
      id: "q1",
      prompt: "Which mode should I use?",
      options: [
        { id: "agent", label: "Agent" },
        { id: "plan", label: "Plan" },
      ],
      allowMultiple: true,
    },
  ],
};

describe("cursor/ask_question", () => {
  it("offers each option with its Cursor id as the answer value", () => {
    assert.deepStrictEqual(cursorAskQuestions(question), [
      {
        id: "q1",
        header: "Need input",
        question: "Which mode should I use?",
        multiSelect: true,
        options: [
          { label: "Agent", description: "Agent", value: "agent" },
          { label: "Plan", description: "Plan", value: "plan" },
        ],
      },
    ]);
  });

  it("answers with the selected option ids, accepting values or labels", () => {
    assert.deepStrictEqual(makeCursorAskQuestionResponse(question, { q1: ["plan", "Agent"] }), {
      outcome: {
        outcome: "answered",
        answers: [{ questionId: "q1", selectedOptionIds: ["plan", "agent"] }],
      },
    });
  });

  it("skips when no answer names an option and cancels a dismissed question", () => {
    assert.equal(
      makeCursorAskQuestionResponse(question, { q1: "something else" }).outcome.outcome,
      "skipped",
    );
    assert.deepStrictEqual(makeCursorAskQuestionResponse(question, null), {
      outcome: { outcome: "cancelled" },
    });
  });
});

describe("cursor/create_plan", () => {
  it("uses the plan markdown Cursor sent", () => {
    assert.equal(
      cursorPlanMarkdown({ toolCallId: "call-2", plan: "# Ship it\n\n1. Build" }),
      "# Ship it\n\n1. Build",
    );
  });

  it("builds markdown from the name, overview and todos when the plan is empty", () => {
    assert.equal(
      cursorPlanMarkdown({
        toolCallId: "call-3",
        name: "Refactor tabs",
        overview: "Tighten layout.",
        plan: " ",
        todos: [
          { id: "1", content: "Inspect sizing", status: "completed" },
          { id: "2", content: "Update layout", status: "pending" },
        ],
      }),
      "# Refactor tabs\n\nTighten layout.\n\n- [x] Inspect sizing\n- [ ] Update layout",
    );
  });
});

describe("Cursor CLI installation", () => {
  it("reads the release from the official install script", () => {
    assert.equal(
      parseCursorCliInstallScriptVersion(
        'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.11.22-e9042b2/${OS}/${ARCH}/agent-cli-package.tar.gz"',
      ),
      "2026.11.22-e9042b2",
    );
    assert.equal(parseCursorCliVersion("2026.11.19-f005e9d\n"), "2026.11.19-f005e9d");
  });

  it.each([
    ["linux", "x64", "https://downloads.cursor.com/lab/v/linux/x64/agent-cli-package.tar.gz"],
    ["darwin", "arm64", "https://downloads.cursor.com/lab/v/darwin/arm64/agent-cli-package.tar.gz"],
    ["win32", "x64", "https://downloads.cursor.com/lab/v/windows/x64/agent-cli-package.zip"],
    ["freebsd", "x64", undefined],
  ] as const)("builds the %s-%s download", (platform, arch, expected) => {
    assert.equal(cursorCliDownloadUrl("v", platform, arch), expected);
  });

  it.each([
    ["dist-package/", true],
    ["dist-package/cursor-agent", true],
    ["dist-package/../evil", false],
    ["/etc/passwd", false],
    ["other/file", false],
    ["dist-package\\x", false],
  ] as const)("treats archive entry %s as safe=%s", (entry, safe) => {
    assert.equal(isSafeCursorCliArchiveEntry(entry), safe);
  });
});

describe("Cursor CLI sign-in", () => {
  it("finds the login link in `agent login` output", () => {
    assert.equal(
      parseCursorCliLoginUrl(
        "Waiting for browser authentication...\nOpen a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc&uuid=1&mode=login\n",
      ),
      "https://cursor.com/loginDeepControl?challenge=abc&uuid=1&mode=login",
    );
  });

  it("ignores links outside Cursor", () => {
    assert.equal(parseCursorCliLoginUrl("visit https://example.com/login now"), undefined);
  });
});
