# Releasing Cox

## Distribution

The `cox-v<VERSION>.tar.gz` release asset contains the tracked source, frozen pnpm lockfile,
prebuilt Web UI and Node server, upstream license, third-party notices and `RELEASE.json`
with the exact source commit. It does not contain dependencies, credentials or user data.
It is **not** a standalone executable: install the required Node and pnpm versions and run
`pnpm install --frozen-lockfile` before `pnpm start`. No build is needed for this asset.
GitHub's automatic source archives do not include prebuilt assets and require `pnpm build`.

Linux x64 is the initially validated platform. Other platforms require compatible native
dependency binaries or a local compiler; no cross-platform binary support is claimed.
Headless preview browsing requires a separately installed Playwright Chromium browser.
On Ubuntu hosts restricting user namespaces, `cox browser setup` can install a Cox-specific
AppArmor profile for Cox's separately named browser directory. This is an explicit host
administration step, never an automatic release-install action; it does not replace T3's profile.

## Android consumers

CoCode installs the standard `@doublepi123/cox` npm package inside its Alpine/PRoot runtime.
Cox no longer builds or publishes separate Android server bundles. The app installs the required
system packages and rebuilds node-pty for the device's musl environment; the npm package is not
a self-contained native binary.

Older CoCode versions that only download Android bundles must upgrade to the npm-capable app to
receive future Cox versions. Previously published release assets are not removed.

## npm automatic publishing

The public package is `@doublepi123/cox`; its executable remains `cox`. The server workspace
keeps its internal `cox` name so existing pnpm filters do not change. `pnpm release:npm` builds
the Web UI and server and creates `release/npm/doublepi123-cox-<VERSION>.tgz`. The generated
package contains only production assets, the README, MIT license, third-party notices and
the runtime dependency patches. External dependencies are pinned to their installed versions;
workspace and catalog references are never published. Install scripts apply the repository's
runtime patches after npm installs dependencies, including on subsequent rebuilds.

`.github/workflows/npm-publish.yml` publishes when a `v*` tag is pushed. The tag must match
both root and server package versions. Stable releases use `latest`; prereleases use `next`.
The workflow typechecks, runs root tests, builds the package and smoke-tests a fresh npm
installation with isolated state before publishing with provenance. The smoke checks include
offline Cursor SDK workspace prewarm and server startup/authentication. It also saves the tarball
as a workflow artifact. Authentication is checked before building. Tag pushes use OIDC and
never silently fall back to a stored token. Use **Run workflow** with an existing version tag
and choose `oidc` (normal releases) or `token` (first publish). Re-running an old failed run
uses its old workflow, not these fixes: start a new manual run from the branch containing the
fix instead. The tagged commit must include the npm packaging scripts and workflow; older
tags cannot use packaging code added afterward. Published npm versions cannot be overwritten.

### Authentication setup

1. Revoke any npm token shared in chat or committed to source. Never put a token in this
   repository, a workflow file or a checked-in `.npmrc`.
2. For the first publish, create a granular npm token for the `doublepi123` scope with package
   write access and permission to bypass 2FA for automated publishing. Store it as the GitHub
   Actions repository secret `NPM_TOKEN` in `doublepi123/cox`. Limit its permissions and expiry.
   Start **Run workflow**, enter the version tag and select `authentication=token`. A token
   that passes `npm whoami` can still lack publish access or Bypass 2FA; E403 at publish time
   requires correcting the token/account policy, not rebuilding the tarball. A missing,
   expired or read-only token cannot be repaired by changing this repository.
3. After the package exists, configure a GitHub Actions trusted publisher in the npm package's
   settings: owner `doublepi123`, repository `cox`, workflow filename `npm-publish.yml`, no
   environment name. Allow direct `npm publish`. The workflow already grants `id-token: write`.
4. Verify a release with `authentication=oidc` (also the default for tag pushes), then delete
   `NPM_TOKEN`, revoke the bootstrap token and restrict token-based publishing in npm.
   OIDC mode does not pass the bootstrap token to npm. The npm user configuration is isolated
   in the runner's temporary directory, so token configuration does not leak into OIDC runs.

Creating a local workflow does not configure npm account permissions, push a tag or publish a
version. Commit and push the reviewed workflow before triggering a release. npm ownership and
trusted-publisher configuration remain explicit maintainer actions.

## Desktop release matrix

Desktop versioning is independent: bump `apps/desktop/package.json` (including its independently
pinned Node engine when necessary) for a shell release, not the root/server versions. Cox
updates change root and `apps/server/package.json`, not the desktop version.

The `Release desktop combinations` workflow implements:

- `v<cox-version>` → npm publication via the existing OIDC workflow → wait for public registry
  propagation → pin the latest stable Cox and the highest published non-draft `desktop-v*`
  release → build combination installers for macOS ARM64/Intel and Windows x64. Attach these
  to the triggering Cox release without replacing the source archive or its `SHA256SUMS`.
- `desktop-v<client-version>` → pin the latest stable Cox → build both combination installers
  and client-only installers on all three platforms. Publish under the desktop tag. This
  does not trigger npm publishing or change the Cox version.
- Manual runs may select a client ref and Cox version for testing; publishing defaults off.
  Manual publishing requires an existing version-matched `desktop-v*` tag. Untagged branch
  test builds cannot silently become releases.

Commit/push the workflow to the default branch, then publish the first independent client
tag (the initial independent version is `desktop-v0.2.1`) before relying on Cox-triggered
builds. Published desktop tags must contain the independent packaging/bootstrap scripts.
The resolver selects desktop releases by semantic version, not GitHub's global Latest flag,
which may refer to a Cox release. It pins both identities once before starting the build matrix.
Stable releases are the automatic update channel; prereleases are not installed automatically.

Desktop installer filenames use the `cox-desktop` prefix. Combination names include both
versions (`cox-desktop-<CLIENT>-cox-<COX>-<OS>-<ARCH>`); client-only names include only the
client version (`cox-desktop-<CLIENT>-client-only-<OS>-<ARCH>`).
Each flavor has separate build metadata and SHA-256 files. An additional
`DESKTOP-SHA256SUMS-client-<CLIENT>-cox-<COX>.txt` is published without overwriting a source
release's checksums. Existing desktop release assets are not removed when Cox releases advance.
Existing release notes and published Latest flags are preserved. The job does not publish a
maintainer-created draft; it only publishes newly created or Actions-owned drafts after
uploading all assets. Newly created combination/desktop releases do not replace the global
Latest flag; a maintainer can promote the complete Cox source release separately.

Native CI builds combination installers from the published stable Cox npm package, exercising
the same staging and symlink-preservation path as releases. It tests client-only first installation
in an isolated home, then a second launch
with `--offline`; it also covers the local API/native terminal, authenticated browser session,
WebSocket origin rejection, renderer isolation, single-instance behavior and graceful exit.
macOS checks unpacked/DMG/ZIP signatures. Ad-hoc signatures do not confer Developer ID trust
or notarization; release signing credentials remain separate.

The npm package declares `coxDesktop.protocol` and its required Node version. The client
rejects incompatible/unknown future protocols and Node runtime changes before installation.
The known pre-manifest desktop-era Cox versions 0.1.40/0.1.41 remain supported on Node 26
to bootstrap the first independently released client. New backend releases must retain the
compatibility metadata; do not remove it to bypass an incompatible-client check.

On initial client-only startup, internet access is required. Installed backends are kept
outside the app bundle; updates are downloaded/staged without interrupting the active backend.
Only the next app launch snapshots userdata and activates a candidate. An interrupted/failed
migration restores the matching snapshot before any previous backend starts. Never implement
binary-only rollback against data that a new backend may already have migrated.

## Maintainer checklist

1. Keep the root and `apps/server` package versions aligned.
2. Install with `pnpm install --frozen-lockfile`.
3. Run `pnpm typecheck`, `pnpm test` and the server, Web and client-runtime package tests.
4. After building, run `pnpm test:smoke` and `pnpm test:dev-smoke` to verify local auth,
   same-origin HTTP/WebSocket access, removed endpoints, isolated state and child cleanup.
5. Commit reviewed source. `pnpm release:pack` rejects an uncommitted source tree.
6. Run `pnpm release:pack`; it builds production assets and creates `release/` artifacts.
7. Extract the archive in a fresh directory, verify `sha256sum -c SHA256SUMS`, install frozen
   dependencies and smoke-test startup with a temporary home/data directory and free port.
8. Push the commit and version tag, then create a GitHub Release with the archive and
   `SHA256SUMS`. Verify the uploaded checksums and release commit before announcing it. No
   Android-specific server archives are produced.

The source workflow validates and packages source without publishing it. Version tags also
trigger npm publishing as described above. GitHub source releases and repository visibility
remain explicit maintainer actions.
