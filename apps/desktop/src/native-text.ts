import type { DesktopBackendUpdateState } from "@t3tools/contracts";

const chinese = {
  "Cox could not stop its backend": "Cox 无法停止本地后端",
  "Update the client first; Cox will be checked again after relaunch.":
    "需要先更新客户端，重新启动后将再次检查 Cox 更新。",
  "Check for updates": "检查更新",
  "Automatic update checks": "自动检查更新",
  "Software updates": "软件更新",
  "Software updates are available.": "发现可用更新。",
  "Updates are ready. Install when your tasks are finished.": "更新已就绪，请在任务结束后安装。",
  "The client and Cox are up to date.": "客户端和 Cox 均已是最新版本。",
  "Could not finish updating. Check for updates again.": "更新未能完成，请重新检查更新。",
  "Restart and install updates?": "重启并安装更新？",
  "Updating quits Cox and interrupts running agent tasks and terminals.":
    "更新会退出 Cox，并中断正在运行的 Agent 任务和终端。",
  "Open installer": "打开安装包",
  Settings: "设置",
  Usage: "用量",
  Connections: "连接管理",
  "Connect to remote server": "连接远程服务器",
  "Enter an HTTPS server origin without credentials, a path, query, or fragment.":
    "请输入不含凭据、路径、查询或片段的 HTTPS 服务器地址。",
  "Invalid remote server identity.": "远程服务器标识无效。",
  "Remote server returned HTTP {status}.": "远程服务器返回 HTTP {status}。",
  "Remote server response is too large.": "远程服务器响应过大。",
  "The server did not return a valid Cox environment descriptor.":
    "服务器未返回有效的 Cox 环境描述信息。",
  "Remote Cox servers must enable COX_AUTH_PASSWORD.":
    "远程 Cox 服务器必须启用 COX_AUTH_PASSWORD。",
  "Cloudflare Access sign-in": "Cloudflare Access 登录",
  "Sign in to Cloudflare Access to connect to this server.":
    "请先登录 Cloudflare Access 再连接此服务器。",
  "Cloudflare Access sign-in was closed before it finished.":
    "Cloudflare Access 登录窗口在完成前被关闭。",
  "Remote server redirected the request. Enter the server's final HTTPS origin.":
    "远程服务器重定向了请求，请输入服务器最终的 HTTPS 地址。",
  "Updating quits Cox. Remote agent tasks and terminals continue on the server.":
    "更新会退出 Cox；远程 Agent 任务和终端会继续在服务器上运行。",
  "The client update is not ready.": "客户端更新尚未就绪。",
  "Forget remote server": "忘记远程服务器",
  "Forget this server and clear its local session and cached data?":
    "忘记此服务器并清除它的本地会话和缓存数据？",
  "Install client update": "安装客户端更新",
  "Updating the client quits Cox and interrupts running agent turns and terminals.":
    "更新客户端会退出 Cox，并中断正在运行的 Agent 任务和终端。",
  Continue: "继续",
  "Check for Client Updates": "检查客户端更新",
  "Cox Desktop {version} is available.": "发现 Cox 客户端 {version} 新版本。",
  "Client update downloaded. Choose Install client update from the {menu} menu when your tasks are finished.":
    "客户端更新已下载，请在任务结束后，从“{menu}”菜单选择“安装客户端更新”。",
  "Could not update the client.": "无法更新客户端。",
  "The client is up to date.": "客户端已是最新版本。",
  "Cox update": "Cox 更新",
  "Cox {version} is available. Download now and activate on the next launch?":
    "发现新版 Cox {version}，是否下载并在下次启动时启用？",
  Later: "稍后",
  Download: "下载",
  "Update now": "立即更新",
  "Restart and update": "重启并更新",
  "Restart and update Cox?": "立即重启并更新 Cox？",
  "Updating Cox restarts the app and interrupts running agent tasks and terminals.":
    "更新 Cox 会重启应用，并中断正在运行的 Agent 任务和终端。",
  "The Cox update is not ready.": "Cox 更新尚未就绪。",
  "Cox {version} is downloaded. Update now to restart Cox, or activate it on the next launch.":
    "Cox {version} 已下载。立即更新会重启 Cox，也可以稍后在下次启动时启用。",
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
  "Allow Cox to write to your clipboard?": "允许 Cox 写入剪贴板？",
  "Allow Cox notifications?": "允许 Cox 发送通知？",
  Deny: "拒绝",
  Allow: "允许",
  File: "文件",
  Help: "帮助",
  "Open Cox": "打开 Cox",
  "Check for Cox Updates": "检查 Cox 更新",
  "Open Logs": "打开日志",
  View: "视图",
  "About Cox": "关于 Cox",
  "Hide Cox": "隐藏 Cox",
  Edit: "编辑",
  Undo: "撤销",
  Redo: "重做",
  Cut: "剪切",
  Copy: "复制",
  Paste: "粘贴",
  "Paste and Match Style": "粘贴并匹配样式",
  Delete: "删除",
  "Select All": "全选",
  Substitutions: "替换",
  "Show Substitutions": "显示替换",
  "Smart Quotes": "智能引号",
  "Smart Dashes": "智能破折号",
  "Text Replacement": "文本替换",
  Speech: "语音",
  "Start Speaking": "开始朗读",
  "Stop Speaking": "停止朗读",
  Reload: "重新加载",
  "Toggle Developer Tools": "切换开发者工具",
  "Actual Size": "实际大小",
  "Zoom In": "放大",
  "Zoom Out": "缩小",
  "Toggle Full Screen": "切换全屏",
  Window: "窗口",
  Minimize: "最小化",
  Zoom: "缩放",
  "Bring All to Front": "前置全部窗口",
  "Ignore this version": "忽略本版本",
  "Ignore all updates": "永久忽略更新",
  "Check for Cox Updates Automatically": "自动检查 Cox 更新",
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

export function desktopConnectionError(locale: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = /^Remote server returned HTTP (\d+)\.$/.exec(message)?.[1];
  if (httpStatus)
    return desktopText(locale, "Remote server returned HTTP {status}.", { status: httpStatus });
  return Object.hasOwn(chinese, message) ? desktopText(locale, message as TextKey) : String(error);
}

export function desktopUpdateNotice(locale: string, state: DesktopBackendUpdateState) {
  const text = (key: TextKey) => desktopText(locale, key);
  let message: string;
  switch (state.status) {
    case "ready":
      return {
        type: "info" as const,
        message: desktopText(
          locale,
          "Cox {version} is downloaded. Update now to restart Cox, or activate it on the next launch.",
          { version: state.latestVersion ?? "" },
        ),
        buttons: [text("Later"), text("Update now")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
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
