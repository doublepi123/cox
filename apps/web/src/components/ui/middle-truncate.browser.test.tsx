import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { MiddleTruncate } from "./middle-truncate";

import "~/index.css";

const narrow = (value: string) => (
  <div style={{ width: 80, display: "flex" }}>
    <MiddleTruncate value={value} />
  </div>
);

describe("MiddleTruncate", () => {
  it("does not clip a short value that replaces a truncated one", async () => {
    await using screen = await render(narrow("t3/investigate-release-build-times"));
    const label = () => screen.container.querySelector("[title] > span");
    await expect.poll(() => label()?.hasAttribute("data-overflow")).toBe(true);

    await screen.rerender(narrow("main"));

    expect(label()).toHaveTextContent("main");
    expect(label()).not.toHaveAttribute("data-overflow");
    expect(label()).toHaveStyle({ clipPath: "none" });
  });
  it("fits every head mounted in the same commit", async () => {
    const values = ["t3/investigate-release-build-times", "t3/remove-stale-worktree-branches"];
    await using screen = await render(
      <>
        {values.map((value) => (
          <div key={value}>{narrow(value)}</div>
        ))}
      </>,
    );
    const heads = () => [
      ...screen.container.querySelectorAll<HTMLElement>("[title] > span:first-child"),
    ];

    await expect
      .poll(() => heads().filter((head) => head.hasAttribute("data-overflow")).length)
      .toBe(2);
  });
});
