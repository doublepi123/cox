const SIDES = ["top", "right", "bottom", "left"] as const;

function readCssPx(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function publishBrowserSafeArea(doc: Document) {
  const probe = doc.createElement("div");
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.paddingTop = "env(safe-area-inset-top, 0px)";
  probe.style.paddingRight = "env(safe-area-inset-right, 0px)";
  probe.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
  probe.style.paddingLeft = "env(safe-area-inset-left, 0px)";
  doc.documentElement.appendChild(probe);
  const computed = doc.defaultView?.getComputedStyle(probe);
  const env = {
    top: readCssPx(computed?.paddingTop ?? ""),
    right: readCssPx(computed?.paddingRight ?? ""),
    bottom: readCssPx(computed?.paddingBottom ?? ""),
    left: readCssPx(computed?.paddingLeft ?? ""),
  };
  probe.remove();
  const root = doc.documentElement;
  for (const side of SIDES) {
    const name = `--workspace-safe-env-${side}`;
    const next = `${env[side]}px`;
    if (root.style.getPropertyValue(name).trim() !== next) {
      root.style.setProperty(name, next);
    }
  }
}

function install() {
  const publish = () => publishBrowserSafeArea(document);
  publish();
  window.addEventListener("resize", publish);
  window.visualViewport?.addEventListener("resize", publish);
}

install();
