import { messages, resolveLanguage } from "./content.js";

const preferenceKey = "cox.site.language";
const themeKey = "cox.site.theme";
const themeModes = ["system", "light", "dark"];
const agentNames = { omo: "OMO", codex: "Codex", claude: "Claude", cursor: "Cursor" };
const dagStates = {
  omo: { progress: "2/5", nodes: ["done", "running", "done", "retry", "wait"] },
  codex: { progress: "3/5", nodes: ["done", "done", "running", "done", "wait"] },
  claude: { progress: "4/5", nodes: ["done", "done", "done", "done", "running"] },
  cursor: { progress: "1/5", nodes: ["done", "running", "wait", "wait", "wait"] },
};
const dagLabels = {
  omo: ["plan.contracts", "impl.i18n", "impl.settings", "impl.tests", "verify"],
  codex: ["plan", "subagent.i18n", "subagent.ui", "subagent.tests", "verify"],
  claude: ["plan", "task.copy", "task.components", "task.drafts", "verify"],
  cursor: ["plan", "edit.settings", "edit.i18n", "edit.tests", "review"],
};
const terminalLines = {
  omo: [
    ["cmd", "omo workflow status settings-i18n"],
    ["ok", "wave 1 plan.contracts", "38s"],
    ["run", "wave 2 impl.i18n", "running"],
    ["retry", "wave 2 impl.tests", "retry 1/3"],
    ["pass", "Todo", "2/5 done"],
    ["cmd", "git worktree list"],
    ["mod", "wt/omo-settings-i18n"],
  ],
  codex: [
    ["cmd", "pnpm test settings"],
    ["ok", "keeps the draft", "42ms"],
    ["ok", "renders zh and en", "18ms"],
    ["pass", "Tests", "12 passed"],
    ["cmd", "git status --short"],
    ["mod", "src/settings/Language.tsx"],
    ["new", "src/i18n/zh.ts"],
  ],
  claude: [
    ["cmd", "pnpm typecheck"],
    ["ok", "no type errors", "3.1s"],
    ["cmd", "pnpm test drafts"],
    ["ok", "draft survives switch", "27ms"],
    ["pass", "Tests", "8 passed"],
    ["cmd", "git diff --stat"],
    ["mod", "3 files changed, +24 -6"],
  ],
  cursor: [
    ["cmd", "pnpm lint src/settings"],
    ["ok", "0 problems", "1.4s"],
    ["cmd", "pnpm test settings --watch"],
    ["run", "watching 3 files", "idle"],
    ["cmd", "git add -p src/settings"],
    ["mod", "src/settings/Language.tsx"],
  ],
};
const demo = document.querySelector("[data-demo]");
const toggle = document.querySelector("[data-language-toggle]");
const themeToggle = document.querySelector("[data-theme-toggle]");
const toast = document.querySelector("[data-toast]");
const workflowTabs = [...document.querySelectorAll("[data-workflow]")];
const workflowPanel = document.querySelector("[data-workflow-panel]");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = matchMedia("(pointer: fine)");
const copiedTimeouts = new WeakMap();

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return;
  }
}

let language = resolveLanguage(
  readStorage(preferenceKey),
  navigator.languages ?? [navigator.language],
);
let theme = readStorage(themeKey);
if (!themeModes.includes(theme)) theme = "system";
let selectedAgent = "omo";
let toastTimeout;

function text(key) {
  const value = messages[language][key];
  return typeof value === "string" && value.trim() ? value : null;
}

function updateAgent() {
  demo.dataset.agent = selectedAgent;
  for (const element of document.querySelectorAll("[data-agent-name]")) {
    element.textContent = agentNames[selectedAgent];
  }
  const message = text(`demo.${selectedAgent}`);
  if (message) document.querySelector("[data-agent-message]").textContent = message;
  for (const button of document.querySelectorAll("[data-provider]")) {
    const selected = button.dataset.provider === selectedAgent;
    button.setAttribute("aria-pressed", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  renderTerminal();
  const dag = document.querySelector("[data-dag]");
  const state = dagStates[selectedAgent];
  dag.dataset.dagAgent = selectedAgent;
  const label = text(`demo.dag.${selectedAgent}`);
  if (label) dag.querySelector("[data-dag-label]").textContent = label;
  dag.querySelector("[data-dag-progress]").textContent = state.progress;
  for (const node of dag.querySelectorAll("[data-dag-node]")) {
    const index = Number(node.dataset.dagNode);
    node.dataset.state = state.nodes[index];
    node.querySelector("code").textContent = dagLabels[selectedAgent][index];
  }
}

function renderTerminal() {
  const terminal = document.querySelector("[data-agent-terminal]");
  if (!terminal) return;
  const rows = terminalLines[selectedAgent].map(([kind, label, detail]) => {
    const row = document.createElement("div");
    row.dataset.line = kind;
    if (kind === "cmd") {
      const prompt = document.createElement("span");
      prompt.className = "t-prompt";
      prompt.textContent = "$";
      row.append(prompt, ` ${label}`);
    } else if (kind === "pass") {
      const badge = document.createElement("span");
      badge.className = "t-pass";
      badge.textContent = label;
      row.append(badge, ` ${detail}`);
    } else if (kind === "mod" || kind === "new") {
      const mark = document.createElement("span");
      mark.className = kind === "mod" ? "t-mod" : "t-new";
      mark.textContent = kind === "mod" ? "M" : "A";
      row.append(mark, ` ${label}`);
    } else {
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", `icon ${kind === "ok" ? "t-ok" : kind === "retry" ? "t-mod" : "t-dim"}`);
      icon.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", kind === "ok" ? "#i-check" : kind === "retry" ? "#i-restore" : "#i-queue");
      icon.append(use);
      const dim = document.createElement("span");
      dim.className = "t-dim";
      dim.textContent = detail;
      row.append(icon, ` ${label} `, dim);
    }
    return row;
  });
  const cursor = document.createElement("div");
  const prompt = document.createElement("span");
  prompt.className = "t-prompt";
  prompt.textContent = "$";
  const caret = document.createElement("span");
  caret.className = "t-cursor";
  cursor.append(prompt, " ", caret);
  terminal.replaceChildren(...rows, cursor);
  terminal.dataset.agentTerminal = selectedAgent;
}

function selectWorkflow(name, focus = false) {
  const tab = workflowTabs.find((button) => button.dataset.workflow === name);
  if (!tab) return;
  for (const button of workflowTabs) {
    const selected = button === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const view of document.querySelectorAll("[data-workflow-view]")) {
    view.hidden = view.dataset.workflowView !== name;
  }
  workflowPanel.dataset.workflowPanel = name;
  workflowPanel.setAttribute("aria-labelledby", tab.id);
  const status = text(`workflow.status${name[0].toUpperCase()}${name.slice(1)}`);
  if (status) document.querySelector("[data-workflow-status]").textContent = status;
  if (focus) tab.focus();
}

function applyTheme() {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  themeToggle.dataset.themeMode = theme;
  const label = text(`theme.${theme}`);
  if (label) {
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
  }
  lattice?.refresh();
}

function applyLanguage() {
  const copy = messages[language];
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  if (text("page.title")) {
    document.title = copy["page.title"];
    document.querySelector('meta[property="og:title"]').content = copy["page.title"];
  }
  if (text("page.description")) {
    document.querySelector('meta[name="description"]').content = copy["page.description"];
    document.querySelector('meta[property="og:description"]').content = copy["page.description"];
  }
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const value = text(element.dataset.i18n);
    if (value) element.textContent = value;
  }
  for (const element of document.querySelectorAll("[data-i18n-aria]")) {
    const value = text(element.dataset.i18nAria);
    if (value) element.setAttribute("aria-label", value);
  }
  for (const element of document.querySelectorAll("[data-i18n-href]")) {
    const value = text(element.dataset.i18nHref);
    if (value) element.href = value;
  }
  toggle.querySelector("[data-language-label]").textContent = language === "zh" ? "EN" : "中文";
  toggle.lang = language === "zh" ? "en" : "zh-CN";
  toggle.setAttribute("aria-label", language === "zh" ? "Switch to English" : "切换为简体中文");
  updateAgent();
  selectWorkflow(workflowPanel.dataset.workflowPanel);
  applyTheme();
}

function showToast(message) {
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 3000);
}

function createLattice(canvas) {
  const hero = canvas.parentElement;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const pitch = 24;
  const pointer = { x: -9999, y: -9999 };
  let width = 0;
  let height = 0;
  let colors = { dot: "", glow: "" };
  let frame = 0;
  let visible = false;

  function readColors() {
    const style = getComputedStyle(document.documentElement);
    colors = {
      dot: style.getPropertyValue("--lattice-dot").trim(),
      glow: style.getPropertyValue("--lattice-glow").trim(),
    };
  }

  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw(time) {
    context.clearRect(0, 0, width, height);
    const drift = reducedMotion.matches ? 0 : time / 9000;
    const offset = (drift * pitch) % pitch;
    for (let y = offset - pitch; y < height + pitch; y += pitch) {
      for (let x = offset - pitch; x < width + pitch; x += pitch) {
        const wave = reducedMotion.matches
          ? 0
          : Math.max(0, Math.sin((x + y) / 180 - time / 1600)) ** 6;
        const distance = Math.hypot(x - pointer.x, y - pointer.y);
        const near = Math.max(0, 1 - distance / 160);
        const strength = Math.max(wave * 0.6, near);
        context.globalAlpha = 1;
        context.fillStyle = colors.dot;
        context.fillRect(x - 1, y - 1, 2, 2);
        if (strength > 0.04) {
          context.globalAlpha = strength;
          context.fillStyle = colors.glow;
          const size = 2 + strength * 2;
          context.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
    }
    context.globalAlpha = 1;
  }

  function loop(time) {
    draw(time);
    frame = requestAnimationFrame(loop);
  }

  function start() {
    if (frame || !visible || document.hidden || reducedMotion.matches) return;
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  function refresh() {
    readColors();
    if (!frame) draw(0);
  }

  readColors();
  resize();
  draw(0);
  new ResizeObserver(() => {
    resize();
    if (!frame) draw(0);
  }).observe(hero);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) start();
    else stop();
  }).observe(hero);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reducedMotion.addEventListener("change", () => {
    stop();
    draw(0);
    start();
  });
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", refresh);
  hero.addEventListener("pointermove", (event) => {
    if (!finePointer.matches || reducedMotion.matches) return;
    const bounds = canvas.getBoundingClientRect();
    pointer.x = event.clientX - bounds.left;
    pointer.y = event.clientY - bounds.top;
  });
  hero.addEventListener("pointerleave", () => {
    pointer.x = -9999;
    pointer.y = -9999;
  });
  return { refresh };
}

function bindSpotlight(grid) {
  let pending = null;
  let scheduled = false;
  grid.addEventListener("pointermove", (event) => {
    if (!finePointer.matches || reducedMotion.matches) return;
    const card = event.target.closest(".card");
    if (!card) return;
    pending = { card, x: event.clientX, y: event.clientY };
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const bounds = pending.card.getBoundingClientRect();
      pending.card.style.setProperty("--mx", `${pending.x - bounds.left}px`);
      pending.card.style.setProperty("--my", `${pending.y - bounds.top}px`);
    });
  });
}

const latticeCanvas = document.querySelector("[data-lattice]");
const lattice = latticeCanvas ? createLattice(latticeCanvas) : null;
const spotlight = document.querySelector("[data-spotlight]");
if (spotlight) bindSpotlight(spotlight);

const verticalTabs = matchMedia("(min-width: 900px)");
function updateTabOrientation() {
  document
    .querySelector("[role='tablist']")
    .setAttribute("aria-orientation", verticalTabs.matches ? "vertical" : "horizontal");
}
verticalTabs.addEventListener("change", updateTabOrientation);
updateTabOrientation();

const header = document.querySelector("[data-header]");
new IntersectionObserver(([entry]) =>
  header.classList.toggle("is-scrolled", !entry.isIntersecting),
).observe(document.querySelector(".hero-head"));

toggle.addEventListener("click", () => {
  language = language === "zh" ? "en" : "zh";
  applyLanguage();
  writeStorage(preferenceKey, language);
});

themeToggle.addEventListener("click", () => {
  theme = themeModes[(themeModes.indexOf(theme) + 1) % themeModes.length];
  applyTheme();
  writeStorage(themeKey, theme === "system" ? null : theme);
});

const providerButtons = [...document.querySelectorAll("[data-provider]")];
for (const button of providerButtons) {
  button.addEventListener("click", () => {
    if (!Object.hasOwn(agentNames, button.dataset.provider)) return;
    selectedAgent = button.dataset.provider;
    updateAgent();
  });
  button.addEventListener("keydown", (event) => {
    const current = providerButtons.indexOf(button);
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (current + 1) % providerButtons.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (current - 1 + providerButtons.length) % providerButtons.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = providerButtons.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    selectedAgent = providerButtons[next].dataset.provider;
    updateAgent();
    providerButtons[next].focus();
  });
}

for (const button of workflowTabs) {
  button.addEventListener("click", () => selectWorkflow(button.dataset.workflow));
  button.addEventListener("keydown", (event) => {
    const current = workflowTabs.indexOf(button);
    let next;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = (current + 1) % workflowTabs.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = (current - 1 + workflowTabs.length) % workflowTabs.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = workflowTabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    selectWorkflow(workflowTabs[next].dataset.workflow, true);
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
    } catch {
      showToast(messages[language]["copy.failure"]);
      return;
    }
    clearTimeout(copiedTimeouts.get(button));
    button.classList.add("is-copied");
    copiedTimeouts.set(
      button,
      setTimeout(() => button.classList.remove("is-copied"), 2000),
    );
    showToast(messages[language]["copy.success"]);
  });
}

applyLanguage();
