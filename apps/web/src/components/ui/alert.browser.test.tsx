import "~/index.css";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { Alert, AlertAction, AlertTitle } from "./alert";

it("wraps the action below the title in a narrow panel", async () => {
  await using screen = await render(
    <div style={{ width: 240 }}>
      <Alert>
        <AlertTitle>Connection interrupted</AlertTitle>
        <AlertAction>
          <button style={{ width: 140 }}>Try again</button>
        </AlertAction>
      </Alert>
    </div>,
  );
  const title = screen.getByText("Connection interrupted").element();
  const action = screen.getByRole("button", { name: "Try again" }).element();
  expect(action.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    title.getBoundingClientRect().bottom,
  );
});
