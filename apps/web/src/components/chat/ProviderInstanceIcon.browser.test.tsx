import { wcagContrast } from "culori";
import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import "~/index.css";
import { render } from "../../../test/render";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

function setTheme(theme: "light" | "dark"): Disposable {
  const originallyDark = document.documentElement.classList.contains("dark");
  document.documentElement.classList.toggle("dark", theme === "dark");
  return {
    [Symbol.dispose]() {
      document.documentElement.classList.toggle("dark", originallyDark);
    },
  };
}

describe("ProviderInstanceIcon OMO logo", () => {
  it.each(["light", "dark"] as const)(
    "renders a local, high-contrast official vector at every icon size in %s mode",
    async (theme) => {
      using _theme = setTheme(theme);
      const sizes = [
        { name: "default", pixels: 20 },
        { name: "compact", pixels: 14, size: "compact" as const },
        { name: "small", pixels: 16, iconClassName: "size-4" },
        { name: "medium", pixels: 24, iconClassName: "size-6" },
        { name: "large-settings", pixels: 48, iconClassName: "size-12" },
      ];
      await using screen = await render(
        <div className="bg-background text-foreground">
          {sizes.map(({ name, iconClassName, size }) => (
            <div key={name} data-testid={name}>
              <ProviderInstanceIcon
                driverKind={ProviderDriverKind.make("omo")}
                displayName="OMO Native"
                size={size ?? "default"}
                iconClassName={iconClassName ?? ""}
              />
            </div>
          ))}
        </div>,
        { router: false },
      );

      for (const { name, pixels } of sizes) {
        const host = screen.getByTestId(name).element();
        const svg = host.querySelector<SVGSVGElement>('svg[data-provider-icon="omo"]')!;
        expect(svg).not.toBeNull();
        expect(svg.getAttribute("aria-hidden")).toBe("true");
        const bounds = svg.getBoundingClientRect();
        expect(bounds.width).toBe(pixels);
        expect(bounds.height).toBe(pixels);
        expect(host.querySelector("img, image, use")).toBeNull();
        expect(host.querySelector(".text-3xs")).toBeNull();
        expect(svg.querySelectorAll("path")).toHaveLength(2);

        const background = svg.querySelector("path")!;
        const mark = svg.querySelector<SVGPathElement>("g path")!;
        const fill = getComputedStyle(mark).fill;
        expect(fill).toBe(getComputedStyle(svg).color);
        expect(wcagContrast(fill, getComputedStyle(background).fill)).toBeGreaterThan(7);

        const markBounds = mark.getBBox();
        const transform = mark.getScreenCTM()!;
        for (const x of [markBounds.x, markBounds.x + markBounds.width]) {
          for (const y of [markBounds.y, markBounds.y + markBounds.height]) {
            const corner = new DOMPoint(x, y).matrixTransform(transform);
            expect(corner.x).toBeGreaterThanOrEqual(bounds.left);
            expect(corner.x).toBeLessThanOrEqual(bounds.right);
            expect(corner.y).toBeGreaterThanOrEqual(bounds.top);
            expect(corner.y).toBeLessThanOrEqual(bounds.bottom);
          }
        }
      }
    },
  );

  it("follows a theme change and keeps instance accents and badges without a monogram fallback", async () => {
    using _theme = setTheme("light");
    const icon = (
      <div className="bg-background text-foreground">
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make("omo")}
          displayName="Work agent"
          accentColor="#2563eb"
          showBadge
          size="compact"
          iconClassName="size-6 text-foreground/80"
        />
      </div>
    );
    await using screen = await render(icon, { router: false });
    const svg = screen.container.querySelector<SVGSVGElement>('svg[data-provider-icon="omo"]')!;
    const mark = svg.querySelector("g path")!;
    const background = svg.querySelector("path")!;
    const lightFill = getComputedStyle(mark).fill;
    expect(svg.getBoundingClientRect().width).toBe(24);
    expect(
      screen.container.querySelector("[data-provider-accent-color]")?.getAttribute("style"),
    ).toContain("--provider-accent: #2563eb");
    await expect.element(screen.getByText("WA", { exact: true })).toBeVisible();

    document.documentElement.classList.add("dark");
    expect(getComputedStyle(mark).fill).not.toBe(lightFill);
    expect(getComputedStyle(mark).fill).toBe(getComputedStyle(svg).color);
    expect(
      wcagContrast(getComputedStyle(mark).fill, getComputedStyle(background).fill),
    ).toBeGreaterThan(7);

    await screen.rerender(
      <ProviderInstanceIcon
        driverKind={ProviderDriverKind.make("omo")}
        displayName="OMO Native"
        showBadge
        badgeContent="none"
        iconClassName="size-4"
      />,
    );
    expect(screen.container.querySelector('svg[data-provider-icon="omo"]')).not.toBeNull();
    expect(screen.container.textContent).not.toContain("ON");
    expect(screen.container.querySelector(".text-3xs")).toBeNull();
  });
});
