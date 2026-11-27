import { describe, expect, it } from "vite-plus/test";

import { textDirection } from "./textDirection";

describe("textDirection", () => {
  it.each([
    ["Arabic", "اكتب دالة تجمع الأرقام", "rtl"],
    ["Hebrew", "תקן את הבאג", "rtl"],
    ["English", "fix the failing test", "ltr"],
    [
      "Arabic that opens with an English term",
      "StrictMode: يعيد الـ render مرتين في التطوير",
      "rtl",
    ],
    ["English quoting one Arabic word", "translate the label مرحبا for the login screen", "ltr"],
    [
      "Arabic sentences around a long English sentence",
      "هذه جملة عربية. The configuration file defines the rendering and formatting options for the entire application. ثم شغّل الاختبارات.",
      "rtl",
    ],
    ["a sentence tie, by total word count", "Done. تم إصلاح المشكلة في الملف الرئيسي", "rtl"],
    [
      "inline abbreviations",
      "هذه جملة عربية تتحدث عن e.g. React i.e. TypeScript JavaScript",
      "rtl",
    ],
    ["a tie, by its first word", "React مكتبة", "ltr"],
    ["a tie that opens in Arabic", "مكتبة React", "rtl"],
    ["Arabic around numbers and punctuation", "عدّل السطر 42، ثم شغّل الاختبارات (3)", "rtl"],
  ])("reads %s", (_, text, direction) => {
    expect(textDirection(text)).toBe(direction);
  });

  it("does not count a byte order mark as a right-to-left letter", () => {
    expect(textDirection("\uFEFFHello")).toBe("ltr");
  });

  it("leaves text without letters to its surroundings", () => {
    expect(textDirection("42 — 7 ✓")).toBeUndefined();
  });
});
