import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";

async function renderBody(host: string, options: { lineBreaks?: boolean } = {}) {
  const context = {
    remarkPlugins: [],
    lineBreaks: sourceControlClients.get(host).hardLineBreaks ?? false,
    threadRef: null,
  };
  return render(
    <PullRequestMarkdownContext value={context}>
      <PullRequestMarkdown
        text={"first line\nsecond line"}
        cwd="/repo"
        environmentId={EnvironmentId.make("local")}
        {...options}
      />
    </PullRequestMarkdownContext>,
  );
}

it.each(["github", "forgejo", "azure-devops"])("%s breaks a single newline", async (host) => {
  await using screen = await renderBody(host);
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(1);
});

it.each(["gitlab", "bitbucket", "gitcafe", "unknown"])(
  "%s joins a single newline",
  async (host) => {
    await using screen = await renderBody(host);
    await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
    expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
  },
);

it("lets text the host did not write opt out of the host's breaks", async () => {
  await using screen = await renderBody("github", { lineBreaks: false });
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
});

it("does not edit an earlier task through a recovered task's synthetic source position", async () => {
  const text =
    "This PR updates local tool config\n\n- [ ] Earlier\n-       Prose\n\n        - [ ] Nested\n";
  const onTaskListChange = vi.fn();
  await using screen = await render(
    <PullRequestMarkdown
      text={text}
      cwd="/repo"
      environmentId={EnvironmentId.make("local")}
      onTaskListChange={onTaskListChange}
    />,
  );
  const boxes = screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes).toHaveLength(2);
  expect(screen.container.textContent).toContain("Earlier");
  expect(screen.container.textContent).toContain("Prose");
  expect(screen.container.textContent).toContain("Nested");
  expect(boxes[0]!.disabled).toBe(false);
  expect(boxes[1]!.disabled).toBe(true);
  await userEvent.click(boxes[0]!);
  expect(onTaskListChange).toHaveBeenCalledExactlyOnceWith({
    markerOffset: text.indexOf("[ ]"),
    checked: true,
  });
});

it("keeps original nested and quoted task source offsets writable beside inert HTML", async () => {
  const text = '- [ ] Parent\n  - [x] Nested\n\n> 12. [X] Quoted\n\n<input type="checkbox">\n';
  const onTaskListChange = vi.fn();
  await using screen = await render(
    <PullRequestMarkdown
      text={text}
      cwd="/repo"
      environmentId={EnvironmentId.make("local")}
      onTaskListChange={onTaskListChange}
    />,
  );
  const boxes = screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect([...boxes].map((box) => box.disabled)).toEqual([false, false, false, true]);
  for (const box of [...boxes].slice(0, 3)) await userEvent.click(box);
  expect(onTaskListChange.mock.calls.map(([input]) => input)).toEqual([
    { markerOffset: text.indexOf("[ ]"), checked: true },
    { markerOffset: text.indexOf("[x]"), checked: false },
    { markerOffset: text.indexOf("[X]"), checked: false },
  ]);
});

it("keeps valid nested and quoted tasks writable after media segmentation", async () => {
  const text =
    "## 𝄞\r\n\r\nhttps://example.com/a.png\r\n\r\n- [ ] Parent\r\n  - [X] Nested\r\n\r\n> 1. [ ] Quoted\r\n";
  const onTaskListChange = vi.fn();
  await using screen = await render(
    <PullRequestMarkdown
      text={text}
      cwd="/repo"
      environmentId={EnvironmentId.make("local")}
      onTaskListChange={onTaskListChange}
    />,
  );
  const boxes = screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect([...boxes].map((box) => box.disabled)).toEqual([false, false, false]);
  expect([...boxes].map((box) => box.checked)).toEqual([false, true, false]);
  await userEvent.click(boxes[1]!);
  await userEvent.click(boxes[2]!);
  expect(onTaskListChange.mock.calls).toEqual([
    [{ markerOffset: text.indexOf("[X]"), checked: false }],
    [{ markerOffset: text.lastIndexOf("[ ]"), checked: true }],
  ]);
});
