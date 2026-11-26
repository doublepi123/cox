import { assert, describe, it } from "@effect/vitest";

import { parseElicitationForm, withOptionalChoices } from "./elicitationForm.ts";

describe("parseElicitationForm", () => {
  it.each(["q0_other", "q0__other"])("routes a custom single-choice answer through %s", (id) => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: { type: "string", enum: ["Postgres", "SQLite"] },
          [id]: { type: "string", title: "Other" },
        },
      },
      "Use Postgres for the new service?",
    );
    assert.deepStrictEqual(
      form?.questions.map((question) => question.id),
      ["q0"],
    );
    assert.deepStrictEqual(form?.content({ q0: "Only on Fridays" }), { [id]: "Only on Fridays" });
    assert.deepStrictEqual(form?.content({ q0: "Postgres" }), { q0: "Postgres" });
  });

  for (const type of ["string", "array"] as const) {
    it.each([
      { values: [" padded ", "", "plain"], labels: ["padded", '""', "plain"] },
      { values: [" a", "a", "b"], labels: ['" a"', '"a"', "b"] },
      { values: [" a", "a", '"a"'], labels: ['" a"', '"a"', '"\\"a\\""'] },
    ])(
      `preserves ${type} enum values with distinct readable labels: $values`,
      ({ values, labels }) => {
        const form = parseElicitationForm(
          {
            type: "object",
            properties: {
              answer:
                type === "array"
                  ? { type, items: { type: "string", enum: values } }
                  : { type, enum: values },
            },
            required: ["answer"],
          },
          "Choose",
        );
        assert(form !== undefined);
        const question = form.questions[0];
        assert(question !== undefined);
        assert.deepStrictEqual(
          question.options.map((option) => option.label),
          labels,
        );
        assert.deepStrictEqual(
          question.options.map((option) => option.value),
          values,
        );
        assert.strictEqual(question.allowCustomAnswer, false);
        assert.strictEqual(question.multiSelect, type === "array" ? true : undefined);
        for (const value of values) {
          const answer = type === "array" ? [value] : value;
          assert.deepStrictEqual(form.content({ answer }), { answer });
        }
      },
    );
  }

  it("requires a multi-select only for a required minimum and accepts none otherwise", () => {
    const items = { type: "string", enum: ["web", "mobile"] };
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          targets: { type: "array", minItems: 1, items },
          extras: { type: "array", items },
          platforms: { type: "array", minItems: 1, items },
        },
        required: ["targets"],
      },
      "Choose",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.required]),
      [
        ["targets", true],
        ["extras", undefined],
        ["platforms", undefined],
      ],
    );
    assert.deepStrictEqual(form.content({ targets: ["web"], extras: [], platforms: [] }), {
      targets: ["web"],
      extras: [],
    });
  });

  it("marks optional number and integer fields as not required and omits blank answers", () => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          limit: { type: "integer" },
          ratio: { type: "number" },
          retries: { type: "integer" },
          threshold: { type: "number" },
        },
        required: ["retries", "threshold"],
      },
      "Configure limits",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.required]),
      [
        ["limit", false],
        ["ratio", false],
        ["retries", undefined],
        ["threshold", undefined],
      ],
    );
    assert.deepStrictEqual(form.content({ limit: "", ratio: "", retries: "3", threshold: "0.5" }), {
      retries: 3,
      threshold: 0.5,
    });
    assert.isUndefined(form.content({ limit: "", ratio: "", retries: "", threshold: "0.5" }));
  });

  it("lets optional boolean and single-choice fields be skipped", () => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          extras: { type: "boolean" },
          mode: { type: "string", enum: ["", "fast"] },
          confirm: { type: "boolean" },
          tier: { type: "string", enum: ["free", "pro"] },
        },
        required: ["confirm", "tier"],
      },
      "Configure run",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.required]),
      [
        ["extras", false],
        ["mode", false],
        ["confirm", undefined],
        ["tier", undefined],
      ],
    );
    assert.deepStrictEqual(form.content({ confirm: "true", tier: "pro" }), {
      confirm: true,
      tier: "pro",
    });
    assert.deepStrictEqual(
      form.content({ extras: "false", mode: "", confirm: "true", tier: "pro" }),
      { extras: false, mode: "", confirm: true, tier: "pro" },
    );
    assert.isUndefined(form.content({ extras: "true", tier: "pro" }));
  });
});

describe("withOptionalChoices", () => {
  const choice = (id: string) => ({
    id,
    header: id,
    question: id,
    options: [{ label: "Fast", description: "Fast", value: "fast" }],
  });
  const form = withOptionalChoices(
    {
      questions: [
        choice("mode"),
        choice("tier"),
        { ...choice("tags"), multiSelect: true },
        { ...choice("notes"), options: [] },
      ],
      respond: (answers) => ({ action: "accept", content: { answered: Object.keys(answers) } }),
    },
    {
      type: "object",
      properties: {
        mode: { type: "string" },
        tier: { type: "string" },
        tags: { type: "array" },
        notes: { type: "string" },
      },
      required: ["tier"],
    },
  );

  it("marks only the single choices the schema leaves optional", () => {
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.required]),
      [
        ["mode", false],
        ["tier", undefined],
        ["tags", undefined],
        ["notes", undefined],
      ],
    );
  });

  it("answers without a skipped choice and cancels without a required one", () => {
    assert.deepStrictEqual(form.respond({ tier: "fast" }), {
      action: "accept",
      content: { answered: ["tier"] },
    });
    assert.deepStrictEqual(form.respond({ mode: "fast" }), { action: "cancel" });
  });
});
