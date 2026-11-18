# Cox Mobile and CoCode Interoperability Guide

Cox supports two complementary native Android packages alongside mobile browsers and iOS: **Cox Mobile** (`@cox/mobile`, `dev.doublepi.cox.mobile`, [`apps/mobile/README.md`](../apps/mobile/README.md)) and **CoCode** (`io.cocode.app`, [`site/cocode/index.html`](../site/cocode/index.html)). Both apps host the Cox server's own Web UI inside per-server isolated WebViews, and both can stay installed on the same Android phone without colliding.

## Side-by-side product comparison

| Dimension                    | Cox Mobile (`@cox/mobile`)                                                                                                     | CoCode (standalone Android)                                                                                              | Mobile Browser / PWA                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **Application ID / surface** | `dev.doublepi.cox.mobile` (`apps/mobile` in this repository)                                                                   | `io.cocode.app` (standalone Android repository)                                                                          | System Safari / Chrome / Firefox (`apps/web`)                       |
| **Supported OSes**           | iOS 17+ and Android 8.0+ (`minSdk = 26`, `targetSdk = 35`)                                                                     | Android 8.0+ (`minSdk = 26`, `targetSdk = 35`, `arm64-v8a` & `x86_64`)                                                   | Modern iOS / iPadOS and Android browsers                            |
| **On-device Cox server**     | Never included (pure-remote launcher + isolated WebView shell, `<20 MB` APK)                                                   | Included: runs `@doublepi123/cox` (`127.0.0.1:3773`) and agent CLIs inside unrooted Alpine Linux + PRoot                 | None (browser client only)                                          |
| **Remote Cox servers**       | Primary purpose: multi-server Connection Manager, 2-slot LRU WebView pool, floating **Servers** switcher                       | Supported alongside the local runtime (2-slot `Local` + `Remote` WebView pool)                                           | Single origin per browser tab or installed Home Screen PWA          |
| **Password storage**         | Optional native vault (`CoxVaultPlugin`: iOS Keychain + Face ID / Touch ID, Android Keystore `AES256_GCM` + `BiometricPrompt`) | App-private `EncryptedSharedPreferences` (`AES256_GCM` master key)                                                       | Browser password manager                                            |
| **Transport policy**         | `https://` default; explicit per-server `allowInsecureHttp` opt-in for password-protected LAN/Tailscale HTTP                   | Loopback `127.0.0.1:3773` for local runtime; `https://` default + explicit `allowInsecureHttp` opt-in for remote servers | `https://` required for nonlocal access and Service Worker features |

### When to choose each on Android

- **Install Cox Mobile (`dev.doublepi.cox.mobile`)** when your projects, toolchains, GPUs, or agent CLIs run on workstations, home lab machines, or VPS instances reachable over Tailscale, Cloudflare Tunnel, or a TLS reverse proxy. You get a tiny install footprint, biometric autofill, and instant switching between two warm remote workspaces.
- **Install CoCode (`io.cocode.app`)** when you want an autonomous Linux coding environment right on your phone or tablet with no computer powered on. CoCode installs and manages `@doublepi123/cox` plus Codex, Claude Code, OpenCode, Grok, and Pi inside Alpine Linux under PRoot, with optional `/sdcard/CoCode/` folder bindings.
- **Install both side by side** if you keep an on-device scratchpad workspace in CoCode while managing multiple remote servers in Cox Mobile. Because `dev.doublepi.cox.mobile` and `io.cocode.app` use distinct Android application IDs, signing namespaces, Keystore aliases, and `androidx.webkit` `ProfileStore` directories, installing, updating, or clearing data in one app never touches the other.

## Shared WebView security invariants

Cox Mobile's Android host (`apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/`) implements the same isolation boundaries proven in CoCode:

1. **Named `MULTI_PROFILE` binding before any load**: each saved remote profile binds a dedicated `androidx.webkit` `ProfileStore` profile (`cox_srv_<uuid>_<sha256_prefix>` in `apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/WorkspacePolicy.kt`, tested by `apps/mobile/src/workspace/androidWorkspacePolicy.test.ts`). Two Cox servers on the same host with different ports (such as `https://cox.example.com:3773` and `https://cox.example.com:3774`) get distinct profile stores as well as port-scoped `t3_session_<port>` cookies.
2. **Fail-closed `IsolationPanel`**: if an unpatched Android System WebView lacks `WebViewFeature.MULTI_PROFILE` (or `WEB_MESSAGE_LISTENER` in Cox Mobile), `CoxWorkspaceWebViewPlugin.kt` refuses to construct a workspace `WebView`, never reads stored passwords, never touches Android's global `Default` `CookieManager`, and displays a native `IsolationPanel` with an **Open in Browser** fallback.
3. **Environment descriptor & `environmentId` pinning**: preflight (`packages/shared/src/remoteServerAdmission.ts`) inspects `GET /.well-known/t3/environment` and `GET /api/auth/session` with `redirect: "manual"`. Remote servers must expose `loginMode: "password"` (`COX_AUTH_PASSWORD`), and saved profiles pin `environmentId` so a different server placed at the same address halts with an identity mismatch error instead of receiving existing session cookies.
4. **Native cookie handoff (`POST /api/auth/browser-session`)**: stored passwords are exchanged in native code (`apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/CoxVaultPlugin.kt` and `apps/mobile/ios/App/Plugins/CoxVaultPlugin.swift`) via a non-redirecting `POST /api/auth/browser-session` call with `Origin` set to `canonicalOrigin`. Returned `Set-Cookie` headers are written straight into the target profile's `CookieManager` / `WKHTTPCookieStore`.
5. **Cloudflare Access `GatewayHandoff` barrier**: when preflight or navigation hits a `*.cloudflareaccess.com` or `/cdn-cgi/access/` gate, both shells allow interactive HTTPS IdP sign-in with all JS bridges detached, quarantine the first bound-origin return behind a ticket-specific `about:blank` document (`apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/GatewayHandoff.kt`), and attach a fresh bridge token only after the main frame commits on the exact canonical origin.
6. **Origin-checked downloads and ordered profile deletion**: native HTTP(S) downloads (`apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/WorkspaceDownloads.kt`) disable automatic redirects, follow at most 5 hops manually, attach the bound profile's `Cookie` header only while every hop stays on `canonicalOrigin`, refuse HTTPS-to-HTTP downgrades, cap transfers at `16 MiB`, and write to `MediaStore.Downloads` (API 29+) or app external Downloads (API 26-28). Removing a server retires its profile gate, destroys any pooled `WebView`, drains queued downloads, deletes the named `ProfileStore` profile, and only then removes the saved server entry.

## `coxMobileShell` bridge contract

`@t3tools/web` detects native mobile shells through a minimal, main-frame-only global (`window.__coxMobileShell__`) validated by Effect Schema in `packages/contracts/src/mobileShellBridge.ts` and `apps/web/src/mobile/mobileShellBridge.ts`.

When committed on the trusted server origin, the native host injects:

```js
window.__coxMobileShell__ = Object.freeze({
  info: Object.freeze({
    platform: "android", // "ios" | "android"
    activeServerLabel: "Workstation",
    serverCount: 2,
  }),
  bridgeToken: "<64-char-hex-per-navigation-token>",
  postMessage: (payload) => {
    // Routes to WebViewCompat.addWebMessageListener ("coxMobileShell") on Android
    // or WKScriptMessageHandler ("coxMobileShell") on iOS
  },
});
window.dispatchEvent(new Event("cox:mobile-shell-change"));
```

Every outbound message from `@t3tools/web` carries `bridgeToken` and matches one of the schemas in `MobileShellBridgeMessage`:

- `{ type: "openServerSwitcher", bridgeToken }`: opens the native server switcher. Current web builds send it from the sidebar `MobileServerSwitcher`.
- `{ type: "setServerSwitcherProvided", bridgeToken, provided }`: tells the native shell that this page has its own server switcher, so the floating pill should hide. `provided: false` restores the mid-screen fallback pill.
- `{ type: "openConnectionManager", bridgeToken }`: returns to the launcher's full Connection Manager.
- `{ type: "syncThemeColor", bridgeToken, color }`: syncs the native container background to a validated CSS color (`<= 64` ASCII chars).
- `{ type: "hapticSelection", bridgeToken }`: triggers native selection haptics on mobile prompt and approval taps.
- `{ type: "saveBlobDownload", bridgeToken, dataUrl, filename, mimeType }`: exports `blob:` / `data:` downloads up to `COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES` (`16 MiB`) with path-traversal-free filenames.

CoCode currently injects its narrower `CoCodeBridge` (`saveFile`, `themeColor`) for blob exports and status bar tinting. Because `@t3tools/web` treats `window.__coxMobileShell__` as optional capability detection (`useMobileShellInfo()` returns `null` when absent), current CoCode builds render the full mobile-optimized Cox Web UI cleanly without modification, and future CoCode releases can adopt `window.__coxMobileShell__` to light up the in-toolbar **Servers** pill and selection haptics using the exact same contract.

## Background notifications across Cox Mobile, CoCode, and PWAs

Cox's server-side notification pipeline (`apps/server/src/notifications/AgentAttentionNotifier.ts`, configured at `/settings/notifications` and served under `/api/notifications/*`) runs directly on your own server with zero Cox-run cloud relay or account services:

- **Mobile Browser / Home-Screen PWA over HTTPS**: supports both RFC 8291/8292 VAPID Web Push (`apps/server/src/notifications/WebPushService.ts` + `apps/web/public/sw.js`) and outbound webhooks. Your Cox server encrypts payloads end-to-end (`aes128gcm`) to the browser's P-256 subscription key and posts opaque ciphertext directly to the browser's standard push endpoint (Apple, Google, or Mozilla push service), so push providers can't read notification plaintext. On iOS 16.4+, add the HTTPS Cox site to the Home Screen first to enable Web Push.
- **Cox Mobile (`@cox/mobile`)**: workspace WebViews don't register browser Push Service endpoints, and servers on private Tailscale or LAN HTTP (`http://192.0.2.10:3773`) run outside HTTPS browser push contexts. Configure outbound **Bark** (recommended on iOS), **Telegram Bot**, **Ntfy**, or **HMAC-signed Generic JSON** webhooks in **Settings -> Notifications** (`apps/server/src/notifications/WebhookNotificationService.ts`). Tapping a notification deep-links to `/<environmentId>/<threadId>` on your server URL.
- **CoCode (`io.cocode.app`)**: CoCode surfaces native Android notifications for local PRoot runtime lifecycle errors, while the embedded Cox server (`127.0.0.1:3773`) can also send outbound Telegram, Ntfy, Bark, or Generic JSON webhooks whenever the phone has network reachability and the local server remains running in CoCode's foreground service.
