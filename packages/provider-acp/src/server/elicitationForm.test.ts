import { assert, describe, it } from "@effect/vitest";

import { parseElicitationForm } from "./elicitationForm.ts";

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
});
