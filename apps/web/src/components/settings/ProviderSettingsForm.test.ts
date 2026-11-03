import { describe, expect, it } from "vite-plus/test";
import {
  makeProviderSettingsSchema,
  ProviderDriverKind,
  SettingsSecretValue,
  TrimmedString,
  secretSettingsFields,
  CodexSettings,
  ClaudeSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { providerClients } from "./providerDriverMeta";
import { en } from "../../i18n/en";
import { zh } from "../../i18n/zh";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  reconcileRowsDraft,
  seedRowsDraft,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("has bilingual resources for every built-in provider form label and description", () => {
    for (const definition of providerClients.definitions) {
      for (const field of deriveProviderSettingsFields(definition)) {
        for (const key of [
          field.label,
          field.description,
          ...(field.options?.map((option) => option.label) ?? []),
        ]) {
          if (key === undefined) continue;
          expect(Object.hasOwn(en, key), `${definition.driverKind}: ${key}`).toBe(true);
          expect(Object.hasOwn(zh, key), `${definition.driverKind}: ${key}`).toBe(true);
        }
      }
    }
  });
  it("offers API URL and securely stored API keys for Codex and Claude", () => {
    for (const [driverKind, settingsSchema] of [
      [ProviderDriverKind.make("codex"), CodexSettings],
      [ProviderDriverKind.make("claudeAgent"), ClaudeSettings],
    ] as const) {
      expect(secretSettingsFields(settingsSchema)).toContain("apiKey");
      const fields = deriveProviderSettingsFields({ driverKind, settingsSchema });
      expect(fields.find((field) => field.key === "baseUrl")?.label).toBe("API URL");
      expect(fields.find((field) => field.key === "apiKey")).toMatchObject({
        secret: true,
        control: "password",
      });
    }
  });
  it("keeps every masked field as a stored secret and offers a reference only where typed so", () => {
    const settingsSchema = makeProviderSettingsSchema({
      token: TrimmedString.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
      apiKey: SettingsSecretValue,
    });

    expect(
      deriveProviderSettingsFields({ settingsSchema }).map(
        ({ key, secret, acceptsSecretReference }) => ({ key, secret, acceptsSecretReference }),
      ),
    ).toEqual([
      { key: "token", secret: true, acceptsSecretReference: undefined },
      { key: "apiKey", secret: true, acceptsSecretReference: true },
    ]);
  });

  it("offers Pi model and credential configuration without changing its existing runtime fields", () => {
    const pi = providerClients.get(ProviderDriverKind.make("pi"));
    expect(pi).toBeDefined();
    const fields = deriveProviderSettingsFields(pi!);
    expect(fields.map((field) => field.key)).toEqual([
      "provider",
      "model",
      "apiKey",
      "agentDir",
      "binaryPath",
      "launchArgs",
    ]);
    expect(fields.find((field) => field.key === "apiKey")).toMatchObject({
      secret: true,
      control: "password",
    });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});

describe("reconcileRowsDraft", () => {
  let nextId = 0;
  const toRows = (values: ReadonlyArray<string>) =>
    values.map((value) => ({ id: nextId++, value }));
  const equal = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
    left.length === right.length && left.every((value, index) => value === right[index]);

  it("keeps rows when an equal value arrives with a new identity", () => {
    const draft = seedRowsDraft(["a"], toRows);
    expect(reconcileRowsDraft(draft, ["a"], equal, toRows)).toBe(draft);
  });

  it("keeps row ids when the published value echoes back", () => {
    const seeded = seedRowsDraft(["a"], toRows);
    const edited = { rows: [...seeded.rows, { id: 99, value: "" }], seen: seeded.seen };
    const draft = { ...edited, lastPublished: ["a", ""] };
    const next = reconcileRowsDraft(draft, ["a", ""], equal, toRows);
    expect(next.rows).toBe(draft.rows);
    expect(next.seen).toEqual(["a", ""]);
    expect(next.lastPublished).toBeUndefined();
  });

  it("reseeds rows when the value changes from outside", () => {
    const draft = { ...seedRowsDraft(["a"], toRows), lastPublished: ["b"] };
    const next = reconcileRowsDraft(draft, ["c"], equal, toRows);
    expect(next.rows.map((row) => row.value)).toEqual(["c"]);
    expect(next.lastPublished).toBeUndefined();
  });
});
