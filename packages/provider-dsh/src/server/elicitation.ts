import { type OrchestrationV2UserInputQuestion, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const OTHER_SUFFIX = "__other";

const isForm = Schema.is(
  Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
);
const isChoice = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    oneOf: Schema.Array(
      Schema.Struct({
        const: Schema.String,
        title: Schema.String,
        description: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const isMultiChoice = Schema.is(
  Schema.Struct({
    type: Schema.Literal("array"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    items: Schema.Struct({ type: Schema.Literal("string"), enum: Schema.Array(Schema.String) }),
  }),
);
const isText = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
  }),
);

const answerTexts = (answer: unknown): ReadonlyArray<string> =>
  (Array.isArray(answer) ? answer : [answer]).flatMap((value) =>
    Predicate.isString(value) && value.trim().length > 0 ? [value.trim()] : [],
  );

// dsh-acp-plus pairs each choice with an optional "<id>__other" text field. The
// client already offers custom answers, so fold the companion into its question.
export const extractDshElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isForm(request.requestedSchema)) return undefined;
  const { properties } = request.requestedSchema;
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  const choiceIds = new Set<string>();
  for (const [id, field] of Object.entries(properties)) {
    if (id.endsWith(OTHER_SUFFIX)) {
      if (!isText(field) || !Object.hasOwn(properties, id.slice(0, -OTHER_SUFFIX.length))) {
        return undefined;
      }
      continue;
    }
    const hasOther = Object.hasOwn(properties, `${id}${OTHER_SUFFIX}`);
    if (isChoice(field) && hasOther) {
      choiceIds.add(id);
      questions.push({
        id,
        header: field.title,
        question: field.description || field.title,
        options: field.oneOf.map((option) => ({
          label: option.title || option.const,
          description: option.description || option.title || option.const,
          value: option.const,
        })),
      });
    } else if (isMultiChoice(field) && hasOther) {
      choiceIds.add(id);
      questions.push({
        id,
        header: field.title,
        question: field.description || field.title,
        multiSelect: true,
        options: field.items.enum.map((value) => ({ label: value, description: value, value })),
      });
    } else if (isText(field) && !hasOther) {
      questions.push({
        id,
        header: field.title,
        question: field.description || field.title,
        options: [],
      });
    } else {
      return undefined;
    }
  }
  if (questions.length === 0) return undefined;
  return {
    questions,
    respond: (answers) => {
      const content: Record<string, string | ReadonlyArray<string>> = {};
      for (const question of questions) {
        const texts = answerTexts(
          Object.hasOwn(answers, question.id) ? answers[question.id] : undefined,
        );
        if (!choiceIds.has(question.id)) {
          if (texts.length > 0) content[question.id] = texts.join("\n");
          continue;
        }
        const values = new Set(question.options.map((option) => option.value));
        const selected = texts.filter((value) => values.has(value));
        const other = texts.filter((value) => !values.has(value));
        if (question.multiSelect === true) content[question.id] = selected;
        else if (selected[0] !== undefined) content[question.id] = selected[0];
        if (other.length > 0) content[`${question.id}${OTHER_SUFFIX}`] = other.join("\n");
      }
      return { action: "accept", content };
    },
  };
};
