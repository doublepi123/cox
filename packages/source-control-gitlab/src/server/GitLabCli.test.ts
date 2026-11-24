import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError } from "@t3tools/contracts";

import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";
import { userFacingSourceControlDetail } from "@t3tools/source-control-core/server/SourceControlProvider";

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(Layer.provide(TestSourceControlHost.layer({ process: { run: mockedRun } }))),
);

function processOutput(stdout: string): SourceControlHost.SourceControlProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

layer("GitLabCli.layer", (it) => {
  it.effect("keeps ambient tokens off an explicitly named secondary host", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValue(Effect.succeed(processOutput("{}")));
      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.execute({
        cwd: "/repo",
        args: ["api", "--hostname", "secondary.example.test", "user"],
        callerNamedHost: "secondary.example.test",
      });
      expect(mockedRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          env: { GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" },
        }),
      );
    }),
  );

  it.effect("parses merge request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              sha: "a".repeat(40),
              state: "closed",
              closed_at: "2026-08-23T10:00:00Z",
              source_project_id: 101,
              target_project_id: 100,
              source_project: {
                path_with_namespace: "octocat/t3code",
              },
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add MR thread creation",
        url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/mr-threads",
        headSha: "a".repeat(40),
        state: "closed",
        closedAt: "2026-08-23T10:00:00Z",
        mergedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/t3code",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "--output", "json", "--", "42"],
        }),
      );
    }),
  );

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                iid: 0,
                title: "invalid",
                web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/0",
                target_branch: "main",
                source_branch: "feature/invalid",
              },
              {
                iid: 43,
                title: "  Valid MR  ",
                web_url: " https://gitlab.com/pingdotgg/t3code/-/merge_requests/43 ",
                target_branch: " main ",
                source_branch: " feature/mr-list ",
                state: "merged",
                merged_at: "2026-08-23T11:00:00Z",
              },
            ]),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/mr-list",
          state: "all",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid MR",
          url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/43",
          baseRefName: "main",
          headRefName: "feature/mr-list",
          state: "merged",
          closedAt: null,
          mergedAt: "2026-08-23T11:00:00Z",
        },
      ]);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "mr",
            "list",
            "--source-branch",
            "feature/mr-list",
            "--all",
            "--per-page",
            "20",
            "--output",
            "json",
          ],
        }),
      );
    }),
  );

  it.effect("classifies expired OAuth grants as authentication failures", () =>
    Effect.gen(function* () {
      const stderr = "oauth2: invalid_grant: refresh token has expired";
      mockedRun.mockImplementation((input) => {
        const failureKind = input.classifyFailure?.(stderr) ?? undefined;
        return Effect.fail(
          new VcsProcessExitError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            exitCode: 1,
            detail: stderr,
            ...(failureKind === undefined ? {} : { failureKind }),
          }),
        );
      });

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.execute({ cwd: "/repo", args: ["auth", "status"] });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliAuthenticationError");
      expect(error.cause).toMatchObject({ failureKind: "authentication" });
      const classifyFailure = mockedRun.mock.calls.at(-1)?.[0].classifyFailure;
      assert.strictEqual(
        classifyFailure?.("Please run `glab auth login` to authenticate."),
        "authentication",
      );
      assert.strictEqual(classifyFailure?.("GET 404 project not found"), "not-found");
    }),
  );

  it.effect(
    "retries oversized MR lists with smaller pages without losing same-named branches",
    () =>
      Effect.gen(function* () {
        const entries = Array.from({ length: 4 }, (_, index) => ({
          iid: index + 1,
          title: "MR " + index,
          // The first alone escapes past the default 1 MB cap; together they pass the list cap.
          description: index === 0 ? '"'.repeat(600_000) : "x".repeat(3_000_000),
          web_url: "https://gitlab.com/acme/web/-/merge_requests/" + (index + 1),
          target_branch: "main",
          source_branch: "feature",
          source_project_id: index === 3 ? 100 : 101,
          target_project_id: 100,
        }));
        mockedRun.mockImplementation((input) => {
          const size = Number(input.args[input.args.indexOf("--per-page") + 1]);
          const pageIndex = input.args.indexOf("--page");
          const page = pageIndex < 0 ? 1 : Number(input.args[pageIndex + 1]);
          const raw = JSON.stringify(entries.slice((page - 1) * size, page * size));
          const cap = input.maxOutputBytes ?? 1_000_000;
          return Effect.succeed({
            ...processOutput(raw.slice(0, cap)),
            stdoutTruncated: raw.length > cap,
          });
        });
        const glab = yield* GitLabCli.GitLabCli;
        const result = yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature",
          state: "open",
          limit: 4,
        });
        assert.deepStrictEqual(
          result.map((mr) => mr.number),
          [1, 2, 3, 4],
        );
        assert.strictEqual(result[3]?.isCrossRepository, false);
      }),
  );

  it.effect("creates same-project MRs without a repository lookup and drafts by title prefix", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/fix",
        title: "Fix remote flow",
        bodyFile: "/tmp/body.md",
      });
      expect(mockedRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/fix",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "title=Fix remote flow",
            "--field",
            "description=@/tmp/body.md",
          ],
        }),
      );

      const bodyFile = "/tmp/body.md";
      const draftTitle = (title: string) =>
        Effect.gen(function* () {
          mockedRun.mockClear();
          mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
          yield* glab.createMergeRequest({
            cwd: "/repo",
            baseBranch: "main",
            headSelector: "feature/fix",
            title,
            bodyFile,
            draft: true,
          });
          return mockedRun.mock.calls[0]?.[0].args.find((arg) => arg.startsWith("title="));
        });
      expect(yield* draftTitle("Fix remote flow")).toBe("title=Draft: Fix remote flow");
      expect(yield* draftTitle("draft: Fix remote flow")).toBe("title=draft: Fix remote flow");
      expect(yield* draftTitle("[Draft] Fix remote flow")).toBe("title=[Draft] Fix remote flow");
    }),
  );

  it.effect("surfaces a friendly error when the merge request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 merge request not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request 4888 was not found"), true);
      assert.strictEqual(error._tag, "GitLabMergeRequestNotFoundError");
      assert.strictEqual(error.command, "glab");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }),
  );

  it.effect.each([
    { host: "gitlab.com", withheld: {} },
    {
      host: "gitlab.example.com",
      withheld: { GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" },
    },
  ])(
    "sends the environment token to a project on $host only when it is glab's default host",
    ({ host, withheld }) =>
      Effect.gen(function* () {
        mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

        const glab = yield* GitLabCli.GitLabCli;
        yield* glab.execute({ cwd: "/repo", host, args: ["api", "user"] });

        expect(mockedRun).toHaveBeenCalledWith(
          expect.objectContaining({ env: { GITLAB_HOST: host, ...withheld } }),
        );
      }),
  );

  it.effect.each([
    { remote: "git@gitlab.com:group/project.git", reference: "42", withheld: {} },
    {
      remote: "https://gitlab.example.com/group/project.git",
      reference: "42",
      withheld: { GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" },
    },
    {
      remote: "git+ssh://git@gitlab.example.com/project.git",
      reference: "42",
      withheld: { GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" },
    },
    {
      remote: "git@gitlab.com:group/project.git",
      reference: "https://gitlab.example.com/group/project/-/merge_requests/42",
      withheld: { GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" },
    },
  ])(
    "keeps the environment token from the host glab picks for $reference in a $remote checkout",
    ({ remote, reference, withheld }) =>
      Effect.gen(function* () {
        const environments: Array<unknown> = [];
        const glab = yield* GitLabCli.make.pipe(
          Effect.provide(
            TestSourceControlHost.layer({
              process: {
                run: (input) => {
                  if (input.command === "git")
                    return Effect.succeed(processOutput(`origin\t${remote} (fetch)\n`));
                  environments.push(input.env);
                  return Effect.succeed(processOutput("{}"));
                },
              },
            }),
          ),
          Effect.provideService(HostProcess.Environment, { GITLAB_TOKEN: "default-host-token" }),
        );
        yield* glab.checkoutMergeRequest({ cwd: "/repo", reference });

        assert.deepStrictEqual(environments, [
          Object.keys(withheld).length === 0 ? undefined : withheld,
        ]);
      }),
  );

  it.effect.each(["not-found", "command-failed"] as const)(
    "exposes fixed repository lookup details only for not-found (%s)",
    (failureKind) =>
      Effect.gen(function* () {
        const cause = new VcsProcessExitError({
          operation: "GitLabCli.execute",
          command: "glab",
          cwd: "/repo",
          exitCode: 1,
          detail: "GET 404 project not found",
          failureKind,
        });
        mockedRun.mockReturnValueOnce(Effect.fail(cause));

        const error = yield* Effect.gen(function* () {
          const glab = yield* GitLabCli.GitLabCli;
          return yield* glab.getRepositoryCloneUrls({
            cwd: "/repo",
            repository: "missing/\tproject",
          });
        }).pipe(Effect.flip);

        assert.strictEqual(error._tag, "GitLabCliCommandError");
        assert.strictEqual(error.cause, cause);
        assert.strictEqual(
          userFacingSourceControlDetail(error),
          failureKind === "not-found"
            ? "Repository missing/ project was not found. Check the owner and name and try again."
            : undefined,
        );
      }),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliRateLimitError");
      assert.strictEqual(error.cause, cause);
    }),
  );
});
