import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TimelineMinimap } from "./TimelineMinimap";

describe("TimelineMinimap pointer visibility", () => {
  const markup = (hasPersistentGutter: boolean) =>
    renderToStaticMarkup(
      <TimelineMinimap
        hasPersistentGutter={hasPersistentGutter}
        hitStripWidth={48}
        currentIndex={0}
        items={[
          { id: "first", rowIndex: 0, userText: "First", assistantText: null },
          { id: "second", rowIndex: 1, userText: "Second", assistantText: null },
        ]}
        stripMap={new Map()}
        onWheel={() => {}}
        onSelect={() => {}}
      />,
    );

  it("leaves the navigation rail visible for all pointers when a gutter is reserved", () => {
    const html = markup(true);
    const className = html.match(/^<div class="([^"]+)"/)![1]!;
    expect(className.split(" ")).not.toContain("hidden");
    expect(className).not.toContain("pointer:fine");
    expect(className).toContain("opacity-100");
    expect(html).toContain('data-persistent-gutter="true"');
  });

  it("restricts the overlapping hover rail to fine pointers without a gutter", () => {
    const html = markup(false);
    const className = html.match(/^<div class="([^"]+)"/)![1]!;
    expect(className.split(" ")).toContain("hidden");
    expect(className).toContain("[@media(pointer:fine)]:block");
    expect(className).toContain("opacity-0");
    expect(html).toContain('data-persistent-gutter="false"');
  });
});
