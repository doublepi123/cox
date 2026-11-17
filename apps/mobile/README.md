# Cox Mobile (`@cox/mobile`)

Cox Mobile is a lightweight, pure-remote client for **iOS 17+** and **Android 8+ Lite** (`dev.doublepi.cox.mobile`). It pairs a local Capacitor Connection Manager with isolated native workspace WebViews so you can connect to multiple self-hosted Cox servers from your phone or tablet without protocol skew, shared cookies, or cloud accounts.

It never embeds a local backend, Linux container, or client self-updater. Every active workspace loads the target server's own matching Web UI directly on that server's origin.

## Choosing a mobile setup

| Option                          | Package / surface                                                                        | Where Cox and agents run                                                                                               | Best fit                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cox Mobile (`@cox/mobile`)**  | `apps/mobile` (`dev.doublepi.cox.mobile`, iOS 17+ IPA & Android 8+ Lite APK)             | On your remote Mac, Linux host, Windows PC, or VPS                                                                     | Switching between multiple remote Cox servers with per-server WebView storage isolation, Face ID / biometric password autofill, and Cloudflare Access handoff in a `<20 MB` app |
| **CoCode (Android standalone)** | `io.cocode.app` ([`docs/mobile-cocode-interop.md`](../../docs/mobile-cocode-interop.md)) | Locally on the Android phone inside unrooted Alpine Linux / PRoot (`127.0.0.1:3773`), plus optional remote Cox servers | Coding directly on an Android phone or tablet when you don't want to depend on a separate computer                                                                              |
| **Mobile Browser / PWA**        | `@t3tools/web` (`apps/web`)                                                              | On your remote Cox server over HTTPS                                                                                   | Zero-install access to a single HTTPS Cox server with browser Web Push support (including iOS 16.4+ Home Screen PWAs)                                                           |

Why is iOS remote-only? Apple's iOS kernel sandbox blocks unprivileged child-process creation and dynamic executable code pages outside system browser entitlements, so local CLI agents and terminal shells can't run on-device. Cox Mobile turns iOS into a fast remote cockpit for the machines where your repositories and agents already live.

For Android coexistence details and shared WebView security rules, see [`docs/mobile-cocode-interop.md`](../../docs/mobile-cocode-interop.md).

## Mobile Web UI capabilities (`@t3tools/web`)

Because Cox Mobile loads the remote server's own `@t3tools/web` bundle, phone ergonomics work identically inside Cox Mobile, CoCode, and mobile browsers (`360px-430px` portrait and landscape):

- **Single-surface sheets and thumb navigation**: viewports `<= 768px` present Diff (`apps/web/src/components/DiffPanelShell.tsx`) and Preview (`apps/web/src/components/preview/PreviewPanelShell.tsx`) as full-width sheets defaulting to unified single-column diffs on `<640px`. A bottom workspace bar (`apps/web/src/components/mobile/MobileWorkspaceBar.tsx`) keeps **Threads**, **New Thread**, **Changes/Diff**, **Terminal**, and the native **Servers** switcher within thumb reach, hiding automatically when the software keyboard opens (`apps/web/src/lib/softwareKeyboard.ts`).
- **Touch composer, approvals, and OMO DAG**: `ask_user_question` prompts (`apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`), tool approvals (`apps/web/src/components/chat/ComposerPendingApprovalActions.tsx`), and secret prompts (`apps/web/src/components/chat/SecretRequestCard.tsx`) size themselves against `--visual-viewport-height` so the virtual keyboard never clips action buttons. `OmoDagPanel` (`apps/web/src/components/chat/OmoDagPanel.tsx`) defaults to a compact wave list on phones with a one-tap toggle into a pinch-to-zoom, touch-pannable dependency graph sheet.
- **Touch Ghostty terminal**: `TerminalTouchKeys` (`apps/web/src/components/terminal/TerminalTouchKeys.tsx`) and `GhosttyTerminalSurface` (`apps/web/src/terminal/ghostty/surface.ts`) add one-shot and double-tap-locked `Ctrl` and `Alt` modifiers, clipboard paste, `A-`/`A+` font-size zoom, and single-finger vertical touch scrollback.
- **Cellular resilience and version-safe caching**: camera photos over `2 MB` compress client-side (`apps/web/src/lib/imageCompression.ts`), interrupted uploads automatically refresh an expired 10-minute signed upload token once without losing your composer draft (`apps/web/src/lib/composerDraftUploads.ts`), and `MobileConnectionBanner` (`apps/web/src/components/chat/MobileConnectionBanner.tsx`) surfaces reconnect status. On HTTPS origins, `/sw.js` (`apps/web/public/sw.js`) fetches HTML navigations strictly network-first (`cache: "no-store"`) while caching only hashed `/assets/*` bundles, preventing `ORCHESTRATION_PROTOCOL_VERSION` mismatches after server upgrades.

## Architecture and security model

### 1. Local launcher vs isolated workspace WebViews

Capacitor hosts only the local Connection Manager (`apps/mobile/src/App.tsx`), running on `capacitor://localhost` on iOS and `https://localhost` on Android. Saved server metadata lives in `apps/mobile/src/connections/store.ts`; QR scanning (`apps/mobile/src/components/QrScannerSheet.tsx`) accepts only `http://` or `https://` server origins, never pairing codes or invitation tokens.

When you tap **Connect**, preflight validation (`packages/shared/src/remoteServerAdmission.ts`) checks `GET /.well-known/t3/environment` and `GET /api/auth/session` without following cross-origin redirects. It verifies a valid Cox environment descriptor, pins `environmentId` on the saved profile so a replaced server can't silently inherit cookies, and requires `COX_AUTH_PASSWORD` (`loginMode === "password"`).

Once admitted, `CoxWorkspaceWebViewPlugin` opens a plain native WebView bound to that profile's isolated data store:

- **iOS 17+** (`apps/mobile/ios/App/Plugins/CoxWorkspaceWebViewPlugin.swift`, `apps/mobile/ios/App/Plugins/WorkspaceSession.swift`): binds each server UUID to a dedicated `WKWebsiteDataStore(forIdentifier: profileUuid)`. Up to 2 workspace WebViews stay warm in an LRU pool for instant switching, with background views evicted on system memory warnings. A draggable floating **Servers** pill (`apps/mobile/ios/App/Plugins/WorkspaceViewController.swift`) returns to the switcher or Connection Manager at any time. Forgetting a server disposes its WebView and awaits `WKWebsiteDataStore.remove(forIdentifier:)` before removing the saved entry.
- **Android 8+ Lite** (`apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/CoxWorkspaceWebViewPlugin.kt`, `apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/WorkspaceView.kt`): requires `androidx.webkit` `WebViewFeature.MULTI_PROFILE` and `WEB_MESSAGE_LISTENER`, binding each `(profileId, canonicalOrigin)` to a named `ProfileStore` profile (`cox_srv_<uuid>_<sha256_prefix>`) in a 2-slot LRU pool with a native **Servers** button. Mixed content, `file://` access, `content://` access, and third-party cookies are disabled. If an outdated Android System WebView lacks `MULTI_PROFILE`, the app fails closed with a native `IsolationPanel` offering **Open in Browser** instead of falling back to the global `CookieManager`. Cloudflare Access preflight also needs that isolated cookie store: without `MULTI_PROFILE`, Cox cannot persist CF cookies for the workspace, so Access login is rejected rather than sharing the process-global cookie jar.

### 2. HTTPS default and explicit LAN / Tailscale HTTP opt-in

Remote entries default to `https://` (such as Tailscale HTTPS `https://cox.example.com`, Cloudflare Tunnel, or a TLS reverse proxy). Credentials in URLs, non-root paths, query strings, and fragments are rejected.

For private networks where you run Cox with `COX_AUTH_PASSWORD` over plain HTTP (for example `http://192.0.2.10:3773` on a trusted LAN or Tailscale IP), you must explicitly enable the per-server insecure HTTP confirmation in `apps/mobile/src/components/ServerEditorSheet.tsx`. Native transport rules (`WKContentRuleList` on iOS and `WorkspaceIdentity.permits` in `apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/WorkspacePolicy.kt`) enforce that choice on every navigation, subresource, and download hop. Profiles saved with `https://` never downgrade to `http://`.

### 3. Biometric credential vault (`CoxVaultPlugin`)

Passwords are never written to `localStorage` or plain JSON profile lists. When you opt into saving a server password (`apps/mobile/src/vault/biometricVault.ts`):

- **iOS** (`apps/mobile/ios/App/Plugins/CoxVaultPlugin.swift`) stores the secret in Apple Keychain (`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`) protected by `SecAccessControl` (`.biometryCurrentSet` for Face ID / Touch ID, or `.userPresence`).
- **Android** (`apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/CoxVaultPlugin.kt`) stores the secret in `EncryptedSharedPreferences` (`AES256_GCM` Keystore master key) gated by `BiometricPrompt` (`BIOMETRIC_STRONG`).

During `unlockAndAutofillPassword`, native code verifies that the caller is the local launcher and that `(profileId, canonicalOrigin)` matches the stored binding, prompts for biometrics, sends a non-redirecting `POST /api/auth/browser-session` request with `{"credential": "..."}`, and writes the returned `Set-Cookie` directly into that profile's isolated cookie store. Remote pages never receive vault access or plaintext passwords. Deleting a server atomically wipes its vault entry.

### 4. Cloudflare Access `GatewayHandoff` and restricted `coxMobileShell` bridge

When a Cox server sits behind Cloudflare Access (`*.cloudflareaccess.com` or `/cdn-cgi/access/`), preflight raises `RemoteGatewayRequiredError` and opens the workspace in gateway handoff mode (`apps/mobile/android/app/src/main/java/dev/doublepi/cox/mobile/GatewayHandoff.kt`, `apps/mobile/ios/App/Plugins/WorkspacePolicy.swift`):

1. Foreign HTTPS identity-provider pages may load in the main frame so you can complete SSO, while `window.__coxMobileShell__` stays detached.
2. When authentication returns to the bound Cox origin outside `/cdn-cgi/`, the WebView quarantines the transition through a ticketed `about:blank` barrier before loading the workspace.
3. Once the main frame commits on the exact canonical origin, native code mints a fresh 256-bit `bridgeToken` and injects `window.__coxMobileShell__` (`apps/mobile/ios/App/Plugins/WorkspaceShellBridge.swift`).

The shell bridge contract (`packages/contracts/src/mobileShellBridge.ts`, `apps/web/src/mobile/mobileShellBridge.ts`) permits only five token-authenticated messages from the top-level frame: `openServerSwitcher`, `openConnectionManager`, `syncThemeColor`, `hapticSelection`, and `saveBlobDownload` (capped at `16 MiB` with sanitized filenames).

## Background notifications (`/settings/notifications`)

Mobile OSes suspend background WebSockets quickly while coding agents keep working on the server. Configure alerts in **Settings -> Notifications** (`/settings/notifications`, backed by `packages/contracts/src/notifications.ts` and `apps/server/src/notifications/http.ts`):

- **Self-hosted Web Push (RFC 8291 / 8292 VAPID)**: Cox operates zero Cox-run cloud relays or account services. `apps/server/src/notifications/WebPushService.ts` auto-generates a P-256 VAPID keypair in `ServerSecretStore`, encrypts payloads end-to-end (`aes128gcm`) to the browser's P-256 subscription key with Node's built-in crypto, and posts the ciphertext directly to the browser's standard push endpoint (Apple, Google, or Mozilla push service), so push providers deliver opaque ciphertext without plaintext access. Endpoints include `GET /api/notifications/vapid-public-key`, `GET` / `POST /api/notifications/push-subscriptions`, `DELETE /api/notifications/push-subscriptions/:id`, and `POST /api/notifications/test` (rate-limited to 5 tests per minute per session). Browser Web Push requires HTTPS; on iOS 16.4+, Safari also requires adding the Cox URL to your Home Screen as a standalone PWA first.
- **Outbound Webhooks (Bark, Telegram Bot, Ntfy, Generic JSON)**: `apps/server/src/notifications/WebhookNotificationService.ts` dispatches up to 10 SSRF-hardened channels stored with redacted secrets. Webhooks work even when you connect through Cox Mobile's native WebView or run Cox over plain HTTP on a private LAN (`allowPrivateNetwork: true` permits private HTTP targets while still blocking loopback to Cox's own port, link-local/metadata IPs, and HTTP redirects).
  - **Bark** (`provider: "bark"`): recommended on iOS for instant `timeSensitive` native notifications with tap-to-open thread deep links, without needing Home Screen PWA setup or public TLS on your Cox server.
  - **Telegram Bot** (`provider: "telegram"`): posts via the Telegram Bot API (or a custom HTTPS bot gateway such as `https://bot.example.com`) with an inline **Open in Cox** button for HTTPS deep links.
  - **Ntfy** (`provider: "ntfy"`): publishes priority-4 JSON alerts with click-through URLs and optional Bearer token auth.
  - **Generic JSON** (`provider: "json"`): sends structured event payloads signed with `X-Cox-Signature-256` (`sha256=<hmac>`) when a secret is set.
- **Signal-only filtering**: `apps/server/src/notifications/AgentAttentionNotifier.ts` fires only on non-archived, non-snoozed top-level threads when a real human prompt (`ask_user_question` / `user_input`, command/file/permission/MCP approvals, or `secret_request`) opens or when the root run settles (`turn_completed`, `turn_failed`). Synthetic OMO internal wait markers (`goal_blocked`, `goal_paused`, `stalled`, `interrupted_run`, and prose `question`) and subagent child completions stay silent.

## Development, verification, and builds

Run workspace commands from the repository root:

```sh
pnpm install
pnpm mobile:dev
pnpm mobile:build
pnpm mobile:test
pnpm mobile:smoke
pnpm --filter @cox/mobile verify:package
```

- `pnpm mobile:dev`: starts the `@cox/mobile` launcher Vite dev server (`apps/mobile/vite.config.ts`).
- `pnpm mobile:build`: compiles the local Connection Manager assets (`webDir: "dist"` in `apps/mobile/capacitor.config.ts`).
- `pnpm mobile:test`: runs Vitest unit and browser/policy suites (`apps/mobile/src/connections/store.test.ts`, `apps/mobile/src/vault/biometricVault.test.ts`, `apps/mobile/src/workspace/iosWorkspacePolicy.test.ts`, `apps/mobile/src/workspace/androidWorkspacePolicy.test.ts`).
- `pnpm mobile:smoke`: runs `apps/mobile/scripts/smoke-mobile-e2e.mjs` against live password-protected local Cox server instances in headless mobile Chromium (`390x844`).
- `pnpm --filter @cox/mobile verify:package`: runs `apps/mobile/scripts/verify-package.ts` to verify `.github/workflows/mobile.yml` and build artifact invariants.
- `node apps/mobile/scripts/verify-ios.mjs`: checks Xcode `IPHONEOS_DEPLOYMENT_TARGET = 17.0`, bundle ID `dev.doublepi.cox.mobile`, WebContent-only ATS rules, and Swift plugin boundaries on Linux or macOS.

### Native platform builds and sideloading

- **Android Lite APK** (`apps/mobile/android/README.md`): requires JDK 21 and Android SDK 35. After `pnpm mobile:build` and `pnpm --filter @cox/mobile exec cap sync android`, run `./gradlew testDebugUnitTest assembleDebug` inside `apps/mobile/android`. Because the application ID is `dev.doublepi.cox.mobile`, it installs cleanly alongside standalone `CoCode` (`io.cocode.app`).
- **iOS 17+ IPA**: requires macOS with Xcode. Run `pnpm mobile:build` and `pnpm --filter @cox/mobile exec cap sync ios`, then archive `apps/mobile/ios/App/App.xcodeproj`. In GitHub Actions (`.github/workflows/mobile.yml`), `ios-ipa` builds an unsigned `.ipa` by default for sideloading with AltStore, SideStore, or TrollStore, or exports a signed App Store Connect archive when `COX_MOBILE_APPLE_CERT_*` secrets are supplied and automatically uploads `mobile-v*` tags and `workflow_dispatch` builds to TestFlight when `APPLE_API_*` secrets are present.
