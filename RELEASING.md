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

## Android server bundle

`cox-<version>-android-linux-<arch>-musl.tar.gz` is a self-contained server tree for the Android
app, which extracts it into Alpine (musl) inside PRoot and starts it with `node bin.mjs`. It
contains `bin.mjs`, `client/`, `node_modules/`, `package.json` and `ANDROID-BUNDLE.json`
(`version`, `arch`, `libc`, `nodeEngine`, `builtWith`, `server`); only `apk add nodejs` is needed
on the device. Native modules are built against musl on the runner's own architecture, so x64 and
arm64 are produced separately and cannot be cross-built without emulation.

`.github/workflows/android-bundle.yml` builds and smoke-tests both bundles, then attaches them to
the release for the pushed `v*` tag, creating the release when it is missing, and merges their
checksums into the release's `SHA256SUMS`. Run it with `workflow_dispatch` and a tag to rebuild
the bundles of an existing release.

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
installation with isolated state before publishing with provenance. It also saves the tarball
as a workflow artifact. Use **Run workflow** with an existing version tag to retry a failed
run. The tagged commit must include the npm packaging scripts and workflow; older tags cannot
use packaging code added afterward. Published npm versions cannot be overwritten.

### Authentication setup

1. Revoke any npm token shared in chat or committed to source. Never put a token in this
   repository, a workflow file or a checked-in `.npmrc`.
2. For the first publish, create a granular npm token for the `doublepi123` scope with package
   write access and permission to bypass 2FA for automated publishing. Store it as the GitHub
   Actions repository secret `NPM_TOKEN` in `doublepi123/cox`. Limit its permissions and expiry.
3. After the package exists, configure a GitHub Actions trusted publisher in the npm package's
   settings: owner `doublepi123`, repository `cox`, workflow filename `npm-publish.yml`, no
   environment name. Allow direct `npm publish`. The workflow already grants `id-token: write`.
4. Verify an OIDC release, then delete `NPM_TOKEN`, revoke the bootstrap token and restrict
   token-based publishing in npm. The same workflow can publish using OIDC without a secret.

Creating a local workflow does not configure npm account permissions, push a tag or publish a
version. Commit and push the reviewed workflow before triggering a release. npm ownership and
trusted-publisher configuration remain explicit maintainer actions.

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
   `SHA256SUMS`. Verify the uploaded checksums and release commit before announcing it. The tag
   also triggers the Android bundle workflow, which attaches the two musl bundles and their
   checksums to that release.

The source workflow validates and packages source without publishing it. Version tags also
trigger npm publishing as described above. GitHub source releases and repository visibility
remain explicit maintainer actions.
