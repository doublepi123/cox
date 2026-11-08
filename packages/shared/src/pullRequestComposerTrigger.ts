import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestFilterOptions,
  PullRequestReferenceCandidate,
  PullRequestReferenceSigil,
} from "@t3tools/contracts";

import { replaceTextRange } from "./composerTrigger.ts";

export type PullRequestComposerTrigger = {
  readonly query: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
} & (
  | { readonly kind: "mention"; readonly sigil: "@" }
  | { readonly kind: "reference"; readonly sigil: PullRequestReferenceSigil }
);

const TOKEN = /^(?:@([A-Za-z0-9_][A-Za-z0-9_.-]*)?|([#!])([\p{L}\p{N}_-]*))$/u;

export type PullRequestCompletionSupport = Pick<
  PullRequestCapabilities,
  "mentions" | "referenceSigils"
>;

export function detectPullRequestComposerTrigger(
  text: string,
  cursor: number,
  support: PullRequestCompletionSupport,
): PullRequestComposerTrigger | null {
  const end = Math.max(0, Math.min(text.length, cursor));
  const next = text[end];
  if (next !== undefined && !/\s/.test(next)) return null;
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
  const match = TOKEN.exec(text.slice(start, end));
  if (!match) return null;
  const sigil = match[2];
  if (sigil === "#" || sigil === "!") {
    return support.referenceSigils?.includes(sigil)
      ? { kind: "reference", sigil, query: match[3] ?? "", rangeStart: start, rangeEnd: end }
      : null;
  }
  return support.mentions === true
    ? { kind: "mention", sigil: "@", query: match[1] ?? "", rangeStart: start, rangeEnd: end }
    : null;
}

export function insertPullRequestCompletion(
  text: string,
  trigger: PullRequestComposerTrigger,
  token: string,
): { text: string; cursor: number } {
  const followedBySpace = /[ \t]/.test(text[trigger.rangeEnd] ?? "");
  if (!followedBySpace) {
    return replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, `${token} `);
  }
  const inserted = replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, token);
  return { ...inserted, cursor: inserted.cursor + 1 };
}

export function pullRequestCompletionKey(
  trigger: Pick<PullRequestComposerTrigger, "sigil" | "query"> | null,
): string | null {
  return trigger === null ? null : `${trigger.sigil}${trigger.query.slice(0, 100)}`;
}

export function debouncedPullRequestCompletionSearch(
  trigger: Pick<PullRequestComposerTrigger, "sigil">,
  debouncedKey: string | null,
): string | undefined {
  return debouncedKey?.startsWith(trigger.sigil)
    ? debouncedKey.slice(trigger.sigil.length) || undefined
    : undefined;
}

export function narrowPullRequestMentions<A extends { login: string; name: string | null }>(
  users: ReadonlyArray<A>,
  typed: string,
  limit: number,
): A[] {
  const needle = typed.toLowerCase();
  return users
    .filter(
      (user) =>
        user.login.toLowerCase().includes(needle) ||
        (user.name?.toLowerCase().includes(needle) ?? false),
    )
    .slice(0, limit);
}

export function narrowPullRequestReferences<
  A extends { reference: string; number: number; title: string },
>(
  candidates: ReadonlyArray<A>,
  trigger: Pick<PullRequestComposerTrigger, "sigil" | "query">,
  limit: number,
): A[] {
  const needle = trigger.query.toLowerCase();
  return candidates
    .filter(
      (candidate) =>
        candidate.reference.startsWith(trigger.sigil) &&
        (String(candidate.number).startsWith(needle) ||
          candidate.title.toLowerCase().includes(needle)),
    )
    .slice(0, limit);
}

export type PullRequestCompletion =
  | { readonly kind: "mention"; readonly token: string; readonly actor: PullRequestActor }
  | {
      readonly kind: "reference";
      readonly token: string;
      readonly candidate: PullRequestReferenceCandidate;
    };

export function pullRequestCompletions(
  trigger: PullRequestComposerTrigger | null,
  options: Pick<PullRequestFilterOptions, "authors" | "references"> | null,
  limit: number,
): ReadonlyArray<PullRequestCompletion> {
  if (trigger === null) return [];
  return trigger.kind === "mention"
    ? narrowPullRequestMentions(options?.authors ?? [], trigger.query, limit).map((actor) => ({
        kind: "mention",
        token: `@${actor.login}`,
        actor,
      }))
    : narrowPullRequestReferences(options?.references ?? [], trigger, limit).map((candidate) => ({
        kind: "reference",
        token: candidate.reference,
        candidate,
      }));
}
