import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export function renderInReact<Result>(render: () => Result): Result {
  let result: Result | undefined;
  function CaptureRender() {
    result = render();
    return null;
  }
  renderToStaticMarkup(createElement(CaptureRender));
  return result!;
}
