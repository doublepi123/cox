import { messages, resolveLanguage } from "./content.js";

const preferenceKey = "cox.site.language";
const agentNames = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
const demo = document.querySelector("[data-demo]");
const toggle = document.querySelector("[data-language-toggle]");
const toast = document.querySelector("[data-toast]");
const workflowTabs = [...document.querySelectorAll("[data-workflow]")];
const workflowPanel = document.querySelector("[data-workflow-panel]");
const copiedTimeouts = new WeakMap();
let preference;
try {
  preference = localStorage.getItem(preferenceKey);
} catch {
  preference = null;
}
let language = resolveLanguage(preference, navigator.languages ?? [navigator.language]);
let selectedAgent = "codex";
let toastTimeout;

function updateAgent() {
  demo.dataset.agent = selectedAgent;
  for (const element of document.querySelectorAll("[data-agent-name]")) {
    element.textContent = agentNames[selectedAgent];
  }
  document.querySelector("[data-agent-message]").textContent =
    messages[language][`demo.${selectedAgent}`];
  for (const button of document.querySelectorAll("[data-provider]")) {
    button.setAttribute("aria-pressed", String(button.dataset.provider === selectedAgent));
  }
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
  document.querySelector("[data-workflow-status]").textContent =
    messages[language][`workflow.status${name[0].toUpperCase()}${name.slice(1)}`];
  if (focus) tab.focus();
}

function applyLanguage() {
  const copy = messages[language];
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = copy["page.title"];
  document.querySelector('meta[name="description"]').content = copy["page.description"];
  document.querySelector('meta[property="og:title"]').content = copy["page.title"];
  document.querySelector('meta[property="og:description"]').content = copy["page.description"];
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const text = copy[element.dataset.i18n];
    if (typeof text === "string" && text.trim()) element.textContent = text;
  }
  for (const element of document.querySelectorAll("[data-i18n-aria]")) {
    const label = copy[element.dataset.i18nAria];
    if (typeof label === "string" && label.trim()) element.setAttribute("aria-label", label);
  }
  for (const element of document.querySelectorAll("[data-i18n-href]")) {
    const href = copy[element.dataset.i18nHref];
    if (typeof href === "string" && href.trim()) element.href = href;
  }
  toggle.querySelector("[data-language-label]").textContent = language === "zh" ? "EN" : "中文";
  toggle.lang = language === "zh" ? "en" : "zh-CN";
  toggle.setAttribute("aria-label", language === "zh" ? "Switch to English" : "切换为简体中文");
  updateAgent();
  selectWorkflow(workflowPanel.dataset.workflowPanel);
}

function showToast(text) {
  clearTimeout(toastTimeout);
  toast.textContent = text;
  toast.classList.add("visible");
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 3000);
}

toggle.addEventListener("click", () => {
  language = language === "zh" ? "en" : "zh";
  applyLanguage();
  try {
    localStorage.setItem(preferenceKey, language);
  } catch {
    return;
  }
});

for (const button of document.querySelectorAll("[data-provider]")) {
  button.addEventListener("click", () => {
    if (!Object.hasOwn(agentNames, button.dataset.provider)) return;
    selectedAgent = button.dataset.provider;
    updateAgent();
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
