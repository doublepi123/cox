const messages = {
  zh: {
    "page.title": "CoCode — 把编码工作台装进口袋",
    "page.description":
      "CoCode 在 Android 手机上本地运行 Cox 和编码智能体，无需电脑，也不需要 root。",
    "nav.label": "主导航",
    "nav.features": "功能",
    "nav.local": "运行方式",
    "nav.download": "下载",
    "hero.eyebrow": "Android 上的 Cox",
    "hero.title": "把编码工作台<br /><span>装进口袋</span>",
    "hero.description": "在 Android 手机上本地运行 Cox 和编码智能体。无需电脑，也不需要 root。",
    "hero.download": "下载 Android APK",
    "hero.cox": "了解 Cox 桌面版",
    "hero.note": "Android 8.0+ · GitHub Releases 提供预发布 APK",
    "demo.label": "CoCode 手机工作台示意",
    "demo.project": "当前项目",
    "demo.thread": "完善首页的移动端布局",
    "demo.time": "刚刚",
    "demo.prompt": "检查手机上的间距和导航，让页面更容易使用。",
    "demo.running": "工作中",
    "demo.message": "我会先检查布局和触摸区域，再运行测试验证改动。",
    "demo.step1": "读取项目文件",
    "demo.step2": "更新移动端样式",
    "demo.step3": "运行测试",
    "demo.local": "Cox 正在本机运行",
    "demo.caption": "界面示意，实际使用 Cox 工作台与所配置的智能体。",
    "agents.title": "选择你的智能体",
    "features.eyebrow": "手机，也能认真写代码",
    "features.title": "不只是远程控制",
    "features.description":
      "CoCode 把运行环境、Cox 和智能体放在手机本地，而不是把电脑桌面投影过来。",
    "feature1.title": "一个本地的编码运行环境",
    "feature1.description":
      "通过 Alpine Linux 与 PRoot 在 Android 上运行 Cox，无需 root。服务仅监听本机回环地址。",
    "feature2.title": "按需安装你的智能体",
    "feature2.description":
      "安装 Codex、Claude Code、OpenCode、Grok 和 Pi；Cursor 使用 Cox 内置 SDK。追加安装不会替换已有智能体。",
    "feature3.title": "模型服务，集中配置",
    "feature3.description":
      "从首页进入 Cox 模型中心，配置服务地址、API 密钥、协议与模型，并绑定到智能体。",
    "feature4.title": "项目和配置，由你掌握",
    "feature4.description":
      "使用 App 私有工作区，或明确授权后映射公共目录。凭据共享有风险，开启前需要单独确认。",
    "local.eyebrow": "手机里的完整工作流",
    "local.title": "电脑不在身边，工作也能继续",
    "local.description":
      "CoCode 管理安装、启动和更新提示；Cox 负责你熟悉的工作台、认证和模型配置。运行时错误会通过系统通知提醒。",
    "local.caveat":
      "本地运行不等于离线推理：智能体仍会调用你配置的模型服务，账号、订阅或 API 额度需自备。",
    "runtime.title": "在这台手机上",
    "runtime.app": "Android 应用与运行环境管理",
    "runtime.server": "本地服务 · 127.0.0.1:3773",
    "download.eyebrow": "从一次 APK 安装开始",
    "download.title": "下一次灵感，不必等到电脑前",
    "download.description":
      "下载签名 APK，安装后按提示准备本地运行环境。首次安装需要联网；升级 APK 不会自动更新正在运行的 Cox。",
    "download.button": "前往 Releases 下载",
    "download.docs": "查看安装与使用说明",
    "download.note":
      "当前为预发布版本。发布验证范围见对应 Release；并非所有智能体的 Android 安装与推理路径均已逐一验证。",
    "ecosystem.eyebrow": "同一套工作台，不同的使用方式",
    "ecosystem.title": "手机上用 CoCode<br />电脑上用 Cox",
    "ecosystem.cox": "面向 macOS、Windows 与浏览器的本地编码工作台",
    "footer.label": "页脚链接",
    "footer.credit": "基于",
    "footer.built": "的运行时管线，以 MIT 许可发布。",
    "footer.source": "源码",
    "footer.releases": "版本发布",
    "footer.note": "这是 CoCode 产品介绍页，不是远程桌面或托管的编码服务。",
  },
  en: {
    "page.title": "CoCode — Your coding workspace, in your pocket",
    "page.description": "Run Cox and your coding agents locally on Android. No computer. No root.",
    "nav.label": "Main navigation",
    "nav.features": "Features",
    "nav.local": "How it works",
    "nav.download": "Download",
    "hero.eyebrow": "Cox on Android",
    "hero.title": "Your coding workspace<br /><span>in your pocket</span>",
    "hero.description":
      "Run Cox and your coding agents locally on your Android phone. No computer. No root.",
    "hero.download": "Download Android APK",
    "hero.cox": "Explore Cox for desktop",
    "hero.note": "Android 8.0+ · Prerelease APKs on GitHub Releases",
    "demo.label": "CoCode mobile workspace illustration",
    "demo.project": "Current project",
    "demo.thread": "Polish the mobile homepage",
    "demo.time": "now",
    "demo.prompt": "Check the spacing and navigation on mobile to make the page easier to use.",
    "demo.running": "Working",
    "demo.message":
      "I’ll inspect the layout and touch targets, then run the tests to verify the changes.",
    "demo.step1": "Read project files",
    "demo.step2": "Update mobile styles",
    "demo.step3": "Run tests",
    "demo.local": "Cox running on this device",
    "demo.caption":
      "Illustrative interface. CoCode uses the Cox workspace and your configured agents.",
    "agents.title": "Choose your agents",
    "features.eyebrow": "Real coding work, on your phone",
    "features.title": "More than remote control",
    "features.description":
      "CoCode puts the runtime, Cox, and your agents on the phone itself, not a mirrored desktop somewhere else.",
    "feature1.title": "A local coding runtime",
    "feature1.description":
      "Run Cox on Android through Alpine Linux and PRoot, without root. The server listens only on loopback.",
    "feature2.title": "Install the agents you need",
    "feature2.description":
      "Install Codex, Claude Code, OpenCode, Grok, and Pi; Cursor uses Cox’s bundled SDK. Adding an agent preserves the others.",
    "feature3.title": "Model services, in one place",
    "feature3.description":
      "Open Cox model services from Home to configure service URLs, API keys, protocols, models, and agent bindings.",
    "feature4.title": "Your projects and configuration",
    "feature4.description":
      "Use the app-private workspace or explicitly grant shared-folder access. Credential sharing carries risks and requires separate consent.",
    "local.eyebrow": "A complete workflow on your phone",
    "local.title": "Keep building, away from your computer",
    "local.description":
      "CoCode handles installation, startup, and update prompts. Cox provides the familiar workspace, authentication, and model configuration. Runtime errors arrive as system notifications.",
    "local.caveat":
      "Local execution doesn’t mean offline inference. Agents still call the model services you configure, using your own accounts, subscriptions, or API credits.",
    "runtime.title": "On this phone",
    "runtime.app": "Android app and runtime management",
    "runtime.server": "Local server · 127.0.0.1:3773",
    "download.eyebrow": "Start with one APK",
    "download.title": "Your next idea shouldn’t have to wait",
    "download.description":
      "Download the signed APK and follow the setup steps for the local runtime. Initial setup needs internet access. Updating the APK does not automatically update a running Cox server.",
    "download.button": "Download from Releases",
    "download.docs": "Read the setup guide",
    "download.note":
      "Currently in prerelease. See each Release for its validation scope; not every agent’s Android installation and inference path has been individually verified.",
    "ecosystem.eyebrow": "One workspace, two ways to use it",
    "ecosystem.title": "CoCode on your phone<br />Cox on your computer",
    "ecosystem.cox": "The local coding workspace for macOS, Windows, and the browser",
    "footer.label": "Footer links",
    "footer.credit": "Built with runtime components from",
    "footer.built": "and released under the MIT license.",
    "footer.source": "Source",
    "footer.releases": "Releases",
    "footer.note": "This is a product introduction, not a remote desktop or hosted coding service.",
  },
};

function resolveLanguage(preference, languages) {
  if (preference === "zh" || preference === "en") return preference;
  return languages
    .find((language) => /^(zh|en)(-|$)/i.test(language))
    ?.toLowerCase()
    .startsWith("zh")
    ? "zh"
    : "en";
}

const toggle = document.querySelector("[data-language-toggle]");
let preference;
try {
  preference = localStorage.getItem("cocode.site.language");
} catch {
  preference = null;
}
let language = resolveLanguage(preference, navigator.languages ?? [navigator.language]);

function applyLanguage() {
  const copy = messages[language];
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = copy["page.title"];
  document.querySelector('meta[name="description"]').content = copy["page.description"];
  document.querySelector('meta[property="og:title"]').content = copy["page.title"];
  document.querySelector('meta[property="og:description"]').content = copy["page.description"];
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const text = copy[element.dataset.i18n];
    if (typeof text === "string" && text.trim()) element.innerHTML = text;
  }
  for (const element of document.querySelectorAll("[data-i18n-aria]")) {
    const label = copy[element.dataset.i18nAria];
    if (typeof label === "string" && label.trim()) element.setAttribute("aria-label", label);
  }
  toggle.querySelector("[data-language-label]").textContent = language === "zh" ? "EN" : "中文";
  toggle.lang = language === "zh" ? "en" : "zh-CN";
  toggle.setAttribute("aria-label", language === "zh" ? "Switch to English" : "切换为简体中文");
}

toggle.addEventListener("click", () => {
  language = language === "zh" ? "en" : "zh";
  applyLanguage();
  try {
    localStorage.setItem("cocode.site.language", language);
  } catch {}
});

applyLanguage();
