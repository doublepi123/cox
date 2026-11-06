import type { DesktopBackendUpdateState } from "@t3tools/contracts";

const chinese = {
  "Cox update": "Cox 更新",
  "Cox {version} is available. Download now and activate on the next launch?":
    "发现新版 Cox {version}，是否下载并在下次启动时启用？",
  Later: "稍后",
  Download: "下载",
  "Update downloaded. It will activate the next time you open Cox without interrupting current tasks.":
    "更新已下载，下次启动 Cox 时生效，不会中断当前任务。",
  "Downloading and verifying Cox. Current tasks will not be interrupted.":
    "正在下载并校验 Cox，不会中断当前任务。",
  "Checking for Cox updates…": "正在检查 Cox 更新…",
  "Cox {version} is available.": "发现新版 Cox {version}。",
  "Cox is up to date.": "Cox 已是最新版本。",
  "No update information is available yet.": "暂时没有可用的更新信息。",
  "The Cox update failed.": "Cox 更新失败。",
  "Update checks are disabled in offline mode.": "离线模式下无法检查更新。",
  "This Cox version failed to start previously. Wait for a newer release.":
    "此 Cox 版本之前启动失败，请等待更新的版本。",
  "This Cox version requires a newer desktop client.": "此 Cox 版本需要更新的桌面客户端。",
  "Quit Cox": "退出 Cox",
  "Quitting stops the local backend and interrupts running agent turns and terminals.":
    "退出会停止本地后端，并中断正在运行的 Agent 任务和终端。",
  Cancel: "取消",
  "Could not open this link in your default browser.": "无法在默认浏览器中打开此链接。",
  "Cox permission": "Cox 权限",
  "Allow Cox to read your clipboard?": "允许 Cox 读取剪贴板？",
  "Allow Cox notifications?": "允许 Cox 发送通知？",
  Deny: "拒绝",
  Allow: "允许",
  File: "文件",
  "Open Cox": "打开 Cox",
  "Check for Cox Updates": "检查 Cox 更新",
  "Open Logs": "打开日志",
  View: "视图",
  "Cox backend stopped": "Cox 后端已停止",
  "Reopen Cox to restart.": "请重新打开 Cox 以重启。",
  Logs: "日志",
  "Cox startup": "Cox 启动",
  "Cox could not start or finish its first installation. Check your connection and retry.":
    "Cox 无法启动或完成首次安装，请检查网络后重试。",
  Quit: "退出",
  Retry: "重试",
  "Cox could not start": "Cox 启动失败",
} as const;

type TextKey = keyof typeof chinese;

export function desktopText(
  locale: string,
  key: TextKey,
  values: Readonly<Record<string, string>> = {},
): string {
  const text = /^zh(?:[-_]|$)/i.test(locale) ? chinese[key] : key;
  return text.replace(/\{([^}]+)\}/g, (placeholder, name: string) => values[name] ?? placeholder);
}

export function desktopUpdateNotice(locale: string, state: DesktopBackendUpdateState) {
  const text = (key: TextKey) => desktopText(locale, key);
  let message: string;
  switch (state.status) {
    case "ready":
      message = text(
        "Update downloaded. It will activate the next time you open Cox without interrupting current tasks.",
      );
      break;
    case "installing":
      message = text("Downloading and verifying Cox. Current tasks will not be interrupted.");
      break;
    case "checking":
      message = text("Checking for Cox updates…");
      break;
    case "available":
      message = desktopText(locale, "Cox {version} is available.", {
        version: state.latestVersion ?? "",
      });
      break;
    case "incompatible":
      message = text("This Cox version requires a newer desktop client.");
      break;
    case "error":
      message = state.message
        ? Object.hasOwn(chinese, state.message)
          ? text(state.message as TextKey)
          : text("The Cox update failed.") + "\n\n" + state.message
        : text("The Cox update failed.");
      break;
    case "idle":
      message = text(
        state.currentVersion && state.latestVersion
          ? "Cox is up to date."
          : "No update information is available yet.",
      );
      break;
  }
  return { type: state.status === "error" ? ("warning" as const) : ("info" as const), message };
}
