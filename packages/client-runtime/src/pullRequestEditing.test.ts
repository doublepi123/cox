import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestComment,
  PullRequestDetail,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canEditPullRequestChangeRequest,
  canEditPullRequestComment,
  canResolvePullRequestThread,
  descriptionDraftInForce,
  settleDescriptionSave,
  startDescriptionSave,
  type DescriptionDraft,
} from "./pullRequestEditing.ts";

type Subject = Pick<PullRequestDetail, "author" | "capabilities" | "viewer" | "viewerPermissions">;

function actor(login: string): PullRequestActor {
  return { login, name: null, avatarUrl: null };
}

function capabilities(edit?: PullRequestCapabilities["edit"]): PullRequestCapabilities {
  return {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: true,
    reactions: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: true, listCandidates: true },
    ...(edit === undefined ? {} : { edit }),
  };
}

function permissions(
  overrides: Partial<PullRequestViewerPermissions> = {},
): PullRequestViewerPermissions {
  return {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: true,
    ...overrides,
  };
}

function subject(overrides: Partial<Subject> = {}): Subject {
  return {
    author: actor("octocat"),
    capabilities: capabilities({ changeRequest: true, comment: true }),
    viewer: "octocat",
    viewerPermissions: permissions(),
    ...overrides,
  };
}

function comment(overrides: Partial<PullRequestComment> = {}): PullRequestComment {
  return {
    id: "c1",
    kind: "issue-comment",
    author: actor("octocat"),
    body: "words",
    createdAt: "2026-01-01T00:00:00.000Z",
    url: null,
    path: null,
    reviewState: null,
    ...overrides,
  };
}

describe("canEditPullRequestChangeRequest", () => {
  it("matches the author regardless of case", () => {
    expect(canEditPullRequestChangeRequest(subject({ viewer: "OctoCat" }))).toBe(true);
  });

  it("lets somebody who may merge rewrite a change request they did not write", () => {
    expect(
      canEditPullRequestChangeRequest(
        subject({
          author: actor("someone-else"),
          viewerPermissions: permissions({ actions: ["merge"] }),
        }),
      ),
    ).toBe(true);
  });

  it("follows the host's own answer about the reader over authorship and merge access", () => {
    expect(
      canEditPullRequestChangeRequest(
        subject({
          author: actor("someone-else"),
          viewerPermissions: permissions({ editChangeRequest: true }),
        }),
      ),
    ).toBe(true);
    expect(
      canEditPullRequestChangeRequest(
        subject({
          viewerPermissions: permissions({ actions: ["merge"], editChangeRequest: false }),
        }),
      ),
    ).toBe(false);
    expect(
      canEditPullRequestChangeRequest(
        subject({
          capabilities: capabilities({ changeRequest: false, comment: true }),
          viewerPermissions: permissions({ editChangeRequest: true }),
        }),
      ),
    ).toBe(false);
  });

  it("refuses a reader who neither wrote it nor may merge it", () => {
    expect(
      canEditPullRequestChangeRequest(
        subject({
          author: actor("someone-else"),
          viewerPermissions: permissions({ actions: ["close"] }),
        }),
      ),
    ).toBe(false);
  });

  it("refuses where the host cannot rewrite a change request at all", () => {
    expect(
      canEditPullRequestChangeRequest(
        subject({ capabilities: capabilities({ changeRequest: false, comment: true }) }),
      ),
    ).toBe(false);
    expect(canEditPullRequestChangeRequest(subject({ capabilities: capabilities() }))).toBe(false);
  });

  it("still allows a merger the host could not name", () => {
    expect(
      canEditPullRequestChangeRequest(
        subject({ viewer: undefined, viewerPermissions: permissions({ actions: ["merge"] }) }),
      ),
    ).toBe(true);
  });
});

describe("canEditPullRequestComment", () => {
  it("lets the reader rewrite their own remark on a line", () => {
    expect(canEditPullRequestComment(subject(), comment({ kind: "review-comment" }))).toBe(true);
  });

  it("matches the author regardless of case", () => {
    expect(
      canEditPullRequestComment(
        subject({ viewer: "OCTOCAT" }),
        comment({ author: actor("octocat") }),
      ),
    ).toBe(true);
  });

  it("refuses somebody else's remark", () => {
    expect(canEditPullRequestComment(subject(), comment({ author: actor("someone-else") }))).toBe(
      false,
    );
  });

  it("follows the host's own answer about a remark over authorship", () => {
    expect(canEditPullRequestComment(subject(), comment({ canEdit: false }))).toBe(false);
    expect(
      canEditPullRequestComment(
        subject(),
        comment({ author: actor("someone-else"), canEdit: true }),
      ),
    ).toBe(true);
    expect(
      canEditPullRequestComment(
        subject({ capabilities: capabilities({ changeRequest: true, comment: false }) }),
        comment({ canEdit: true }),
      ),
    ).toBe(false);
  });

  it("refuses a review's own summary", () => {
    expect(canEditPullRequestComment(subject(), comment({ kind: "review" }))).toBe(false);
  });
});

describe("canResolvePullRequestThread", () => {
  it("uses the reader's repository-wide permission where the host says nothing per thread", () => {
    expect(canResolvePullRequestThread(subject(), {})).toBe(true);
    expect(
      canResolvePullRequestThread(
        subject({ viewerPermissions: permissions({ resolve: false }) }),
        {},
      ),
    ).toBe(false);
  });

  it("only narrows the reader's permission with the host's answer for one thread", () => {
    expect(canResolvePullRequestThread(subject(), { canResolve: false })).toBe(false);
    expect(
      canResolvePullRequestThread(subject({ viewerPermissions: permissions({ resolve: false }) }), {
        canResolve: true,
      }),
    ).toBe(false);
  });
});

describe("description drafts", () => {
  const url = "https://github.com/owner/repo/pull/1";
  const unticked = "- [ ] Ship it";
  const ticked = "- [x] Ship it";

  it("hides readings taken during the saves and ends at the first one after them", () => {
    let draft: DescriptionDraft | null = startDescriptionSave(
      null,
      { url, observedAt: 1 },
      { id: 1, body: ticked },
    );
    draft = startDescriptionSave(draft, { url, observedAt: 1 }, { id: 2, body: unticked });
    expect(descriptionDraftInForce(draft, url, 2)?.body).toBe(unticked);
    draft = descriptionDraftInForce(draft, url, 2);
    draft = settleDescriptionSave(draft, url, 1, true);
    expect(descriptionDraftInForce(draft, url, 2)?.body).toBe(unticked);
    draft = settleDescriptionSave(draft, url, 2, true);
    expect(descriptionDraftInForce(draft, url, 2)?.body).toBe(unticked);
    expect(descriptionDraftInForce(draft, url, 3)).toBeNull();
  });

  it("outlives failed saves until a reading after the last one, losing the body only with it", () => {
    let draft: DescriptionDraft | null = startDescriptionSave(
      null,
      { url, observedAt: 1 },
      { id: 1, body: ticked },
    );
    draft = startDescriptionSave(draft, { url, observedAt: 1 }, { id: 2, body: unticked });
    draft = settleDescriptionSave(draft, url, 1, false);
    expect(descriptionDraftInForce(draft, url, 2)).toMatchObject({ body: unticked, saves: 1 });
    draft = descriptionDraftInForce(draft, url, 2);
    draft = settleDescriptionSave(draft, url, 2, false);
    expect(descriptionDraftInForce(draft, url, 2)).toMatchObject({ body: null, saves: 0 });
    expect(settleDescriptionSave(draft, url, 2, true)).toBe(draft);
    expect(descriptionDraftInForce(draft, url, 3)).toBeNull();
  });

  it("retains confirmed prose when a later checkbox save fails before refresh", () => {
    const body = `Confirmed prose\n\n${unticked}`;
    let draft: DescriptionDraft | null = startDescriptionSave(
      null,
      { url, observedAt: 1 },
      { id: 1, body },
    );
    draft = settleDescriptionSave(draft, url, 1, true);
    draft = startDescriptionSave(
      draft,
      { url, observedAt: 1 },
      { id: 2, body: body.replace("[ ]", "[x]") },
    );
    draft = settleDescriptionSave(draft, url, 2, false);
    expect(descriptionDraftInForce(draft, url, 1)?.body).toBe(body);
    draft = startDescriptionSave(
      draft,
      { url, observedAt: 1 },
      { id: 3, body: body.replace("[ ]", "[x]") },
    );
    draft = settleDescriptionSave(draft, url, 3, false);
    expect(descriptionDraftInForce(draft, url, 1)?.body).toBe(body);
  });

  it.each([
    [true, true, false],
    [true, false, false],
    [false, true, false],
    [false, false, false],
    [true, true, true],
    [true, false, true],
    [false, true, true],
    [false, false, true],
  ])(
    "settles queued saves first=%s last=%s reverse completion=%s",
    (firstSaved, lastSaved, reverse) => {
      const first = "- [x] First\n- [ ] Second";
      const last = "- [x] First\n- [x] Second";
      let draft: DescriptionDraft | null = startDescriptionSave(
        null,
        { url, observedAt: 1 },
        { id: 1, body: first },
      );
      draft = startDescriptionSave(draft, { url, observedAt: 1 }, { id: 2, body: last });
      draft = settleDescriptionSave(draft, url, reverse ? 2 : 1, reverse ? lastSaved : firstSaved);
      expect(draft?.body).toBe(reverse && !lastSaved ? first : last);
      draft = settleDescriptionSave(draft, url, reverse ? 1 : 2, reverse ? firstSaved : lastSaved);
      expect(draft).toMatchObject({ body: lastSaved ? last : firstSaved ? first : null, saves: 0 });
      expect(descriptionDraftInForce(draft, url, 2)).toBeNull();
    },
  );

  it("retains a confirmed empty body without timestamps until a timestamped reading arrives", () => {
    let draft: DescriptionDraft | null = startDescriptionSave(null, { url }, { id: 1, body: "" });
    draft = settleDescriptionSave(draft, url, 1, true);
    draft = descriptionDraftInForce(draft, url, undefined);
    draft = startDescriptionSave(draft, { url }, { id: 2, body: ticked });
    draft = settleDescriptionSave(draft, url, 2, false);
    expect(descriptionDraftInForce(draft, url, undefined)?.body).toBe("");
    expect(descriptionDraftInForce(draft, url, 1)).toBeNull();
  });

  it("does not carry a confirmed baseline into a new host reading", () => {
    let draft: DescriptionDraft | null = startDescriptionSave(
      null,
      { url, observedAt: 1 },
      { id: 1, body: ticked },
    );
    draft = settleDescriptionSave(draft, url, 1, true);
    draft = startDescriptionSave(draft, { url, observedAt: 2 }, { id: 2, body: unticked });
    draft = settleDescriptionSave(draft, url, 2, false);
    expect(draft?.body).toBeNull();
  });

  it("belongs to one change request and ignores obsolete completions after returning to it", () => {
    const other = "https://github.com/owner/repo/pull/2";
    let draft: DescriptionDraft | null = startDescriptionSave(
      null,
      { url, observedAt: 1 },
      { id: 1, body: ticked },
    );
    expect(descriptionDraftInForce(draft, other, 1)).toBeNull();
    expect(settleDescriptionSave(draft, other, 1, false)).toBe(draft);
    draft = startDescriptionSave(draft, { url: other, observedAt: 5 }, { id: 2, body: unticked });
    expect(draft.saves).toBe(1);
    draft = startDescriptionSave(draft, { url, observedAt: 6 }, { id: 3, body: ticked });
    expect(settleDescriptionSave(draft, url, 1, true)).toBe(draft);
    expect(settleDescriptionSave(draft, other, 2, false)).toBe(draft);
    draft = settleDescriptionSave(draft, url, 3, false);
    expect(draft).toMatchObject({ body: null, saves: 0 });
  });
});
