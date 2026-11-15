import {
  RemoteAdmissionError,
  RemoteEnvironmentMismatchError,
  RemoteGatewayRequiredError,
} from "@t3tools/shared/remoteServerAdmission";
import { VaultError } from "./vault/biometricVault";

export const LOCALE_STORAGE_KEY = "cox.mobile.locale";

export type Locale = "en" | "zh-CN";

const en = {
  appTitle: "Remote cockpit",
  appDescription:
    "Connect to Cox servers that you operate. Each server keeps its own workspace data.",
  addServer: "Add server",
  scanQr: "Scan QR",
  savedServers: "Saved servers",
  noServersTitle: "No servers saved",
  noServersBody: "Add an HTTPS origin or scan a server URL to begin.",
  connect: "Connect",
  moveUp: "Move up",
  moveDown: "Move down",
  holdToReorder: "Hold to reorder",
  edit: "Edit",
  forget: "Forget",
  https: "HTTPS",
  httpOptIn: "HTTP Opt-In",
  verified: "Verified",
  notConnected: "Not connected yet",
  unverified: "Not verified",
  identity_mismatch: "Identity changed",
  gateway_required: "Gateway required",
  unreachable: "Unreachable",
  vaultSaved: "Vault enabled",
  environment: "Environment",
  serverVersion: "Cox version",
  addServerTitle: "Add a remote server",
  editServerTitle: "Edit remote server",
  editorDescription: "Cox checks the server identity and password authentication before saving it.",
  nameLabel: "Display name",
  namePlaceholder: "Optional",
  originLabel: "Server origin",
  originHelp: "Use an origin only, without a path, query, fragment, or credentials.",
  allowHttp: "Allow password-protected plain HTTP on trusted LAN/Tailscale",
  allowHttpWarning:
    "Plain HTTP exposes traffic to the local network. Enable it only for a server you trust.",
  savePasswordInVault: "Save the password in the biometric vault",
  vaultHelp: "The native vault stores the password and asks you to unlock it when connecting.",
  vaultPassword: "Server password",
  vaultKeepPassword: "Leave blank to keep the saved password for this origin.",
  vaultInvalid: "Enter a password before enabling the vault or changing the server origin.",
  vaultUnavailable:
    "The native vault could not complete the operation. Unlock your device and try again.",
  saveServer: "Verify and save",
  saving: "Checking server",
  cancel: "Cancel",
  close: "Close",
  qrTitle: "Scan a server URL",
  qrDescription: "The QR code must contain only an HTTP or HTTPS server origin.",
  startCamera: "Start camera",
  cameraActive: "Point the camera at the server QR code.",
  cameraUnavailable:
    "Live scanning needs BarcodeDetector and camera access. Paste the origin instead.",
  cameraFailed: "The camera could not be opened. Paste the origin instead.",
  qrInputLabel: "Or paste a server origin",
  qrInputPlaceholder: "https://cox.example.com",
  useOrigin: "Use origin",
  forgetTitle: "Forget this server?",
  forgetWarning:
    "Removing the profile also wipes its isolated cookies, WebView storage, and saved Keychain or Keystore credential.",
  keepServer: "Keep server",
  forgetServer: "Forget server",
  preferences: "Preferences",
  language: "Language",
  theme: "Theme",
  system: "System",
  dark: "Dark",
  light: "Light",
  securityNote: "HTTPS is required by default. Passwords are never written to the server list.",
  connectionReady: "Server identity verified. The native workspace handoff is ready.",
  invalidOrigin: "Enter a valid server origin without credentials, a path, query, or fragment.",
  httpOptInRequired: "Enable the explicit HTTP option before using a plain HTTP server.",
  gatewayRequired: "Cloudflare Access login required on connect.",
  identityMismatch:
    "The server identity changed. Connecting is blocked. Forget this profile and add it again only if the change was expected.",
  passwordRequired: "The server must enable COX_AUTH_PASSWORD.",
  redirected: "The server redirected the request. Enter its final origin.",
  httpError: "The server returned an HTTP error during preflight.",
  invalidResponse: "The server returned an invalid Cox descriptor.",
  networkError: "The server could not be reached. Check its address and your connection.",
  unknownError: "The connection could not be completed.",
} as const;

export type TranslationKey = keyof typeof en;
export type Translator = (key: TranslationKey) => string;

const zhCN: Record<TranslationKey, string> = {
  appTitle: "远程驾驶舱",
  appDescription: "连接你自己部署的 Cox 服务器。每台服务器的工作区数据彼此隔离。",
  addServer: "添加服务器",
  scanQr: "扫描二维码",
  savedServers: "已保存的服务器",
  noServersTitle: "尚未保存服务器",
  noServersBody: "添加 HTTPS 地址或扫描服务器 URL 二维码开始连接。",
  connect: "连接",
  moveUp: "上移",
  moveDown: "下移",
  holdToReorder: "长按拖动排序",
  edit: "编辑",
  forget: "忘记",
  https: "HTTPS",
  httpOptIn: "HTTP 已授权",
  verified: "已验证",
  notConnected: "尚未连接",
  unverified: "尚未验证",
  identity_mismatch: "身份已更改",
  gateway_required: "需要网关验证",
  unreachable: "无法连接",
  vaultSaved: "已启用保险箱",
  environment: "环境",
  serverVersion: "Cox 版本",
  addServerTitle: "添加远程服务器",
  editServerTitle: "编辑远程服务器",
  editorDescription: "保存前，Cox 会验证服务器身份和密码认证配置。",
  nameLabel: "显示名称",
  namePlaceholder: "可选",
  originLabel: "服务器地址",
  originHelp: "仅填写源地址，不要包含路径、查询参数、片段或凭据。",
  allowHttp: "允许在可信 LAN/Tailscale 上使用带密码保护的明文 HTTP",
  allowHttpWarning: "明文 HTTP 会向本地网络暴露流量。仅对你信任的服务器启用。",
  savePasswordInVault: "将密码保存到生物识别保险箱",
  vaultHelp: "原生保险箱保存密码，连接时需要解锁。",
  vaultPassword: "服务器密码",
  vaultKeepPassword: "留空以保留此地址已保存的密码。",
  vaultInvalid: "启用保险箱或更改服务器地址前，请输入密码。",
  vaultUnavailable: "原生保险箱无法完成操作。请解锁设备后重试。",
  saveServer: "验证并保存",
  saving: "正在检查服务器",
  cancel: "取消",
  close: "关闭",
  qrTitle: "扫描服务器 URL",
  qrDescription: "二维码只能包含 HTTP 或 HTTPS 服务器源地址。",
  startCamera: "启动相机",
  cameraActive: "将相机对准服务器二维码。",
  cameraUnavailable: "实时扫描需要 BarcodeDetector 和相机权限。也可以手动粘贴源地址。",
  cameraFailed: "无法启动相机。请手动粘贴源地址。",
  qrInputLabel: "或粘贴服务器源地址",
  qrInputPlaceholder: "https://cox.example.com",
  useOrigin: "使用此地址",
  forgetTitle: "忘记此服务器？",
  forgetWarning:
    "移除配置还会清除其隔离的 Cookie、WebView 存储以及已保存的 Keychain 或 Keystore 凭据。",
  keepServer: "保留服务器",
  forgetServer: "忘记服务器",
  preferences: "偏好设置",
  language: "语言",
  theme: "主题",
  system: "跟随系统",
  dark: "深色",
  light: "浅色",
  securityNote: "默认要求 HTTPS。密码绝不会写入服务器列表。",
  connectionReady: "服务器身份已验证，可以交由原生工作区打开。",
  invalidOrigin: "请输入不含凭据、路径、查询参数或片段的有效服务器源地址。",
  httpOptInRequired: "使用明文 HTTP 服务器前，必须显式启用 HTTP 选项。",
  gatewayRequired: "连接时需要先登录 Cloudflare Access。",
  identityMismatch:
    "服务器身份已变化，连接已被阻止。仅在确认这是预期变更时，忘记此配置并重新添加。",
  passwordRequired: "服务器必须启用 COX_AUTH_PASSWORD。",
  redirected: "服务器重定向了请求，请输入最终源地址。",
  httpError: "预检时服务器返回了 HTTP 错误。",
  invalidResponse: "服务器返回了无效的 Cox 环境描述。",
  networkError: "无法访问服务器，请检查地址和网络连接。",
  unknownError: "无法完成连接。",
};

const translations: Record<Locale, Record<TranslationKey, string>> = { en, "zh-CN": zhCN };

export function translator(locale: Locale): Translator {
  return (key) => translations[locale][key];
}

export function readInitialLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === "zh-CN" || stored === "en") return stored;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function applyLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}

const admissionErrorKeys: Record<RemoteAdmissionError["code"], TranslationKey> = {
  malformed_input: "invalidOrigin",
  redirect: "redirected",
  http_error: "httpError",
  invalid_response: "invalidResponse",
  password_required: "passwordRequired",
};

const vaultErrorKeys: Record<VaultError["code"], TranslationKey> = {
  invalid_input: "vaultInvalid",
  unavailable: "vaultUnavailable",
};

export function formatConnectionError(error: unknown, t: Translator): string {
  if (error instanceof VaultError) return t(vaultErrorKeys[error.code]);
  if (error instanceof RemoteGatewayRequiredError) return t("gatewayRequired");
  if (error instanceof RemoteEnvironmentMismatchError) return t("identityMismatch");
  if (error instanceof RemoteAdmissionError) return t(admissionErrorKeys[error.code]);
  if (error instanceof TypeError) return t("networkError");
  if (error instanceof Error) return error.message;
  return t("unknownError");
}
