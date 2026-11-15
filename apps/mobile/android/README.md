# Android workspace host

The launcher uses Capacitor. Remote workspaces use plain Android WebViews bound to
named AndroidX WebKit profiles before settings, cookies, or navigation are accessed.
Unsupported multi-profile or WebMessage capabilities show the native isolation
panel without constructing a workspace WebView.

`network_security_config.xml` permits cleartext at the platform layer because saved
servers can explicitly opt into HTTP on arbitrary LAN or Tailscale addresses.
`WorkspaceIdentity.permits` is the application transport gate for workspace opens,
navigation, subresources, and native download hops. HTTPS profiles cannot downgrade,
even if an insecure flag is supplied. The launcher has no remote navigation allowlist.

Profile names combine the saved UUID and SHA-256 of the canonical origin, including
non-default ports. The two-view LRU pool retains thread paths across eviction.
Forgetting a profile retires its policy, destroys its view, drains queued downloads,
and only then deletes the named profile.

Cloudflare gateway navigation temporarily permits HTTPS identity-provider pages.
Those pages have no shell token. The return navigation is quarantined behind a
ticket-specific blank document; the matching start and finish callbacks must occur
before the trusted page is loaded. Tokens are 256-bit random values rotated at
document commits, and messages must come from the canonical main frame.

Downloads follow at most five redirects, use the profile's cookies only while the
entire chain stays on its origin, and stream at most 16 MiB into a pending download.
Android 10+ publishes into MediaStore Downloads. Android 8 and 9 use app-specific
external Downloads storage with a partial-file rename because MediaStore Downloads
does not exist on those releases.

Build with JDK 21 and Android SDK 35 after `pnpm --filter @cox/mobile build` and
`pnpm --filter @cox/mobile exec cap sync android`:

```sh
cd apps/mobile/android
./gradlew testDebugUnitTest assembleDebug
```

`WorkspacePolicyTest` covers the native policy. The TypeScript mirror in
`src/workspace/androidWorkspacePolicy.test.ts` exercises the same security contracts
on hosts without an Android toolchain. The mirror and structural audits do not
replace native compilation or device QA.
