import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";

const CursorTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});

export const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      prompt: Schema.String,
      options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
      allowMultiple: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type CursorAskQuestionRequest = typeof CursorAskQuestionRequest.Type;

export const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.optional(Schema.Array(CursorTodo)),
  phases: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, todos: Schema.Array(CursorTodo) })),
  ),
});
export type CursorCreatePlanRequest = typeof CursorCreatePlanRequest.Type;

export type CursorAskQuestionResponse = {
  readonly outcome:
    | {
        readonly outcome: "answered";
        readonly answers: ReadonlyArray<{
          readonly questionId: string;
          readonly selectedOptionIds: ReadonlyArray<string>;
        }>;
      }
    | { readonly outcome: "skipped"; readonly reason?: string }
    | { readonly outcome: "cancelled" };
};

export type CursorCreatePlanResponse = {
  readonly outcome: { readonly outcome: "accepted" };
};

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function cursorAskQuestions(
  params: CursorAskQuestionRequest,
): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  const header = nonEmpty(params.title) ?? "Question";
  return params.questions.flatMap((question) => {
    const id = nonEmpty(question.id);
    const prompt = nonEmpty(question.prompt);
    if (id === undefined || prompt === undefined) return [];
    const options = question.options.flatMap((option) => {
      const label = nonEmpty(option.label);
      const value = nonEmpty(option.id);
      return label === undefined || value === undefined
        ? []
        : [{ label, description: label, value }];
    });
    return [
      {
        id,
        header,
        question: prompt,
        multiSelect: question.allowMultiple === true,
        options: options.length > 0 ? options : [{ label: "OK", description: "Continue" }],
      },
    ];
  });
}

function answerValues(answer: unknown): ReadonlyArray<string> {
  const values = Array.isArray(answer) ? answer : [answer];
  return values.flatMap((value) => {
    const text = typeof value === "string" ? value.trim() : "";
    return text ? [text] : [];
  });
}

export function makeCursorAskQuestionResponse(
  params: CursorAskQuestionRequest,
  answers: ProviderUserInputAnswers | null,
): CursorAskQuestionResponse {
  if (answers === null) return { outcome: { outcome: "cancelled" } };
  const answered = params.questions.flatMap((question) => {
    const selected = answerValues(answers[question.id]).flatMap((value) => {
      const option = question.options.find(
        (candidate) => candidate.id === value || candidate.label.trim() === value,
      );
      return option === undefined ? [] : [option.id];
    });
    const selectedOptionIds = [...new Set(selected)];
    return selectedOptionIds.length === 0 ? [] : [{ questionId: question.id, selectedOptionIds }];
  });
  return answered.length === 0
    ? { outcome: { outcome: "skipped", reason: "The user did not choose an option." } }
    : { outcome: { outcome: "answered", answers: answered } };
}

function todoLines(
  todos: ReadonlyArray<typeof CursorTodo.Type> | undefined,
): ReadonlyArray<string> {
  return (todos ?? []).flatMap((todo) => {
    const content = nonEmpty(todo.content);
    if (content === undefined) return [];
    return [`- [${todo.status === "completed" ? "x" : " "}] ${content}`];
  });
}

export function cursorPlanMarkdown(params: CursorCreatePlanRequest): string {
  const plan = nonEmpty(params.plan);
  if (plan !== undefined) return plan;
  const name = nonEmpty(params.name);
  const overview = nonEmpty(params.overview);
  const sections = [
    `# ${name ?? "Plan"}`,
    ...(overview === undefined ? [] : [overview]),
    ...(params.phases ?? []).flatMap((phase) => {
      const lines = todoLines(phase.todos);
      return lines.length === 0 ? [] : [`## ${phase.name.trim()}`, lines.join("\n")];
    }),
  ];
  const todos = todoLines(params.todos);
  return [...sections, ...(todos.length === 0 ? [] : [todos.join("\n")])].join("\n\n");
}

export const registerCursorCliAcpExtensions = ({
  runtime,
  requestUserInput,
  captureProposedPlan,
}: Pick<AcpAdapterV2ExtensionContext, "runtime" | "requestUserInput" | "captureProposedPlan">) =>
  Effect.all(
    [
      runtime.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params, context) =>
        requestUserInput(
          {
            nativeItemId: `cursor-question:${params.toolCallId}`,
            nativeRequestId: params.toolCallId,
            questions: cursorAskQuestions(params),
          },
          context,
        ).pipe(
          Effect.flatMap(({ acknowledgeNativeResponse, answers }) =>
            acknowledgeNativeResponse.pipe(
              Effect.as(makeCursorAskQuestionResponse(params, answers)),
            ),
          ),
        ),
      ),
      runtime.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
        captureProposedPlan({ planMarkdown: cursorPlanMarkdown(params) }).pipe(
          Effect.as<CursorCreatePlanResponse>({ outcome: { outcome: "accepted" } }),
        ),
      ),
    ],
    { discard: true },
  );
