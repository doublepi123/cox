import { messages, resolveLanguage } from "./content.js";

const preferenceKey = "cox.site.language";
const agentNames = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
const demo = document.querySelector("[data-demo]");
const toggle = document.querySelector("[data-language-toggle]");
const toast = document.querySelector("[data-toast]");
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

function applyLanguage() {
  const copy = messages[language];
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = copy["page.title"];
  document.querySelector('meta[name="description"]').content = copy["page.description"];
  document.querySelector('meta[property="og:title"]').content = copy["page.title"];
  document.querySelector('meta[property="og:description"]').content = copy["page.description"];
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = copy[element.dataset.i18n];
  }
  for (const element of document.querySelectorAll("[data-i18n-aria]")) {
    element.setAttribute("aria-label", copy[element.dataset.i18nAria]);
  }
  for (const element of document.querySelectorAll("[data-i18n-href]")) {
    element.href = copy[element.dataset.i18nHref];
  }
  toggle.querySelector("[data-language-label]").textContent = language === "zh" ? "EN" : "中文";
  toggle.lang = language === "zh" ? "en" : "zh-CN";
  toggle.setAttribute("aria-label", language === "zh" ? "Switch to English" : "切换为简体中文");
  updateAgent();
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
