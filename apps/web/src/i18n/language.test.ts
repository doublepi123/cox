import { describe, expect, it } from "vite-plus/test";

import { en } from "./en";
import { zh } from "./zh";
import {
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
} from "../components/settings/settingsSearch";
import {
  detectDeviceLanguage,
  parseLanguagePreference,
  resolveLanguage,
  translate,
} from "./language";

describe("device language", () => {
  it.each([
    [["zh-CN", "en-US"], "zh"],
    [["zh-TW"], "zh"],
    [["ZH_hans_CN"], "zh"],
    [["en-GB", "zh-CN"], "en"],
    [["fr-FR", "zh-HK"], "zh"],
    [["ja-JP", "de-DE"], "en"],
    [[], "en"],
    [["not-zh", "eng"], "en"],
  ] as const)("resolves %j to %s", (languages, language) => {
    expect(detectDeviceLanguage(languages)).toBe(language);
  });

  it("gives explicit preferences priority over the device", () => {
    expect(resolveLanguage("en", ["zh-CN"])).toBe("en");
    expect(resolveLanguage("zh", ["en-US"])).toBe("zh");
    expect(resolveLanguage("system", ["zh-CN"])).toBe("zh");
  });

  it.each([null, undefined, "", "fr", "ZH", {}, 1])("ignores malformed preference %j", (value) => {
    expect(parseLanguagePreference(value)).toBe("system");
  });
});

describe("translation resources", () => {
  it("keeps English and Chinese keys complete", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(en)) {
      expect(value).toBe(key);
      expect(translate("zh", key).trim().length).toBeGreaterThan(0);
    }
  });

  it("translates interface keys and preserves unknown content", () => {
    expect(translate("zh", "Add project")).toBe("添加项目");
    expect(translate("en", "Add project")).toBe("Add project");
    expect(translate("zh", "const message = 'Settings';")).toBe("const message = 'Settings';");
    expect(translate("zh", "toString")).toBe("toString");
  });

  it("covers settings catalog titles and navigation labels in both resources", () => {
    const titles = [
      ...SETTINGS_SEARCH_ITEMS.map((item) => item.title),
      ...Object.values(SETTINGS_SECTION_LABELS),
    ];
    expect(titles.filter((title) => !Object.hasOwn(en, title))).toEqual([]);
    expect(titles.filter((title) => !Object.hasOwn(zh, title))).toEqual([]);
  });

  it("uses a whitespace-free follow-up sentence key without normalizing raw content", () => {
    const sentence = "Queue follow-ups while the agent runs or steer the current run.";
    expect(translate("zh", sentence)).toBe("代理运行时将后续消息排队，或立即引导当前运行。");
    expect(Object.hasOwn(en, `${sentence} `)).toBe(false);
    expect(translate("zh", ` ${sentence} `)).toBe(` ${sentence} `);
  });

  it("preserves interpolation placeholders in every translation", () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(zh)) {
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });

  it("interpolates explicit values without evaluating them", () => {
    expect(translate("zh", "File {name}: {count}", { name: "<script>", count: 2 })).toBe(
      "File <script>: 2",
    );
    expect(translate("en", "{missing}", {})).toBe("{missing}");
  });
});
