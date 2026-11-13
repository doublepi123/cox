# Cox website

A standalone, bilingual product website for GitHub Pages. It is a static introduction,
not a hosted instance of Cox. It has no analytics, external fonts, service connections,
or application credentials. The interactive workspace is explicitly illustrative;
switching providers never starts an agent or sends a prompt.

## Build and test

From the repository root, using Node.js 26.12.1:

```sh
node --test scripts/test-pages.mjs
node scripts/build-pages.mjs
```

With pnpm installed, the equivalent commands are `pnpm pages:test` and `pnpm pages:build`.
Only the allowlisted public files are copied to `site/dist/`. No application build or
workspace dependency installation is needed. All asset paths are relative, so the same
output works under a project path such as `/cox/` or at a custom domain's root.
The build adds content-derived version queries to stylesheet and script URLs, including
the translation module import. Publish the build output rather than the source files so
returning visitors do not mix new markup with cached styles or translations. Missing
translation keys preserve the readable HTML fallback instead of clearing the text.

With workspace dependencies and Playwright's Chromium installed, `pnpm pages:test:browser`
also checks the real page at a `/cox/` subpath: responsive layouts without horizontal
overflow, a 12px minimum for visible text, language persistence, provider illustrations,
clipboard success/failure, and navigation. It starts only a temporary, loopback static
server and never connects to the local Cox deployment.
Set `COX_PAGES_SCREENSHOTS` to an output directory to save desktop and phone screenshots.

Serve `site/dist/` using any static HTTP server to preview it. Do not use a Cox server or
production data directory for the website. Opening the HTML as a `file:` URL is not a
supported preview method because the language resources use JavaScript modules.

## Account homepage

The primary website is `https://doublepi.dev/`, published from the root of
`doublepi123/doublepi123.github.io` on its `master` branch. It replaces the previous
personal homepage; the previous commit remains available in Git history for rollback.
Only the public build output, a website README, and the project's MIT license belong
in that repository. Do not copy the Cox application's data, credentials, or build output.

Build with `pnpm pages:build`, replace the homepage repository's published content with
`site/dist/` (preserving its `.git` directory), include Cox's `LICENSE`, and review the
diff before committing/pushing. The existing GitHub Pages source is **Deploy from a
branch → master → /(root)**. Verify the Pages build's commit and live files after publishing.
Do not clear Git history, force-push, or delete the homepage repository to update the site.

The build includes `cox/index.html`, which redirects the previously shared `/cox/`
address to the homepage even when JavaScript is disabled. Canonical and social-image
metadata point to the account homepage, not the old project address.

CoCode is published at `https://doublepi.dev/cocode/` from the same build and homepage
repository. Its source lives in `site/cocode/`, including its official icon, MIT license
and upstream notice. Keep its assets and links relative so both pages work under a
project subpath as well as the custom domain. The build versions each page's scripts
and styles independently. Publish the entire allowlist, including the `cocode/` directory,
on every homepage update; do not replace it with a root-only file copy.

The former `doublepi123/cocode.doublepi.dev` repository only serves the compatibility
redirect in `site/redirects/cocode.html`. Preserve its existing CNAME and history when
updating that redirect. The new site needs no separate subdomain DNS or certificate;
the old URL can redirect only if its own DNS and HTTPS are reachable.

## Checks and optional project Pages

The **Cox website** workflow tests and builds the site for pushes to `main` and pull
requests that change it. These runs never publish, and the workflow never updates the
account-homepage repository.

The same workflow can publish a separate project Pages site, but only when run manually.
Pages is not enabled for this repository: a project site would serve
`https://doublepi123.github.io/cox/` instead of the homepage's redirect. To use it anyway:

1. In the repository's **Settings → Pages → Build and deployment**, choose
   **GitHub Actions** as the source. A repository administrator may need to enable Pages.
2. Use **Actions → Cox website → Run workflow** on `main`. It tests and builds the static
   site, then publishes `site/dist/` to the `github-pages` environment.
3. Check the workflow's deployment output and open the resulting URL before announcing
   the site. If the first deployment needs approval, approve the `github-pages` environment.

If the repository or owner changes, update the GitHub/npm links and this documentation.
Also update the absolute `og:image` URL in `index.html` for a different owner or custom
domain. The account homepage uses the custom domain `doublepi.dev`.

## Editing

- `DESIGN.md`: the single source of truth for the shared color, type, spacing, radius,
  elevation and motion tokens. Change a token there first, then apply it in `styles.css`;
  component CSS must not hardcode those values.
- `index.html`: semantic layout, the inline SVG icon sprite, the hero canvas hook, the
  capabilities bento, and readable Chinese content without JavaScript.
- `styles.css`: tokens derived from `DESIGN.md` for both themes (dark by default, plus
  `[data-theme="light"]` and `prefers-color-scheme: light`), responsive layout, container
  queries for the illustrated workspace, system fonts, and reduced-motion support.
- `content.js`: matching Chinese/English text, per-language links and language selection.
- `main.js`: persisted language preference, the theme cycle and its storage key, the hero
  canvas lattice, the agent illustration, keyboard-accessible workflow tabs, and clipboard
  feedback.
- `assets/cox.svg`: Cox's existing logo, shared visually with the application.
- `assets/social.svg` / `social.png`: editable source and its 1200×630 social sharing card.
  Render `social.png` from `social.svg` in a headless browser at 1200×630 after editing it.
- `cox/index.html`: compatibility redirect for the old project website address.
- `cocode/`: bilingual Android product page and its own license and attribution. It keeps
  its own `data-theme` state and `cocode.site.theme` preference.
- `redirects/cocode.html`: legacy subdomain redirect, deployed only to the old repository.

Draw icons with the SVG sprite (`<svg class="icon"><use href="#i-name" /></svg>`), not
Unicode symbols: arrows, dingbats, and other symbol glyphs fall back to inconsistent fonts
or missing-glyph boxes on many phones. Keep visible text at 12px or larger, and avoid
negative letter spacing for Chinese text. The illustrated workspace adapts to its own width
(sidebar from 720px, side panel from 1060px) instead of shrinking its text.

The site follows a supported browser language on first visit, falling back to English.
The language switch stores `cox.site.language` or `cocode.site.language` in the browser. The
Cox and CoCode theme buttons cycle system → light → dark; an explicit choice is stored as
`cox.site.theme` or `cocode.site.theme` and restored before the stylesheet paints. Each page
keeps its own preference. Keep launch commands, paths, provider names, and code samples unchanged
when translating.

The hero lattice is a decorative canvas behind the Cox headline. Its animation loop stops while
the hero is off screen or the document is hidden, and it draws a single static frame under
`prefers-reduced-motion: reduce`; the canvas keeps its size and colors in both themes. The
capabilities bento (`#capabilities`) is the layout that carries the OMO workflow and local
gateway cards; keep its card hooks when adding sections so the showcase stays readable at every
breakpoint.

Do not add real account details, local screenshots with private content, or claims that
local control means offline model inference. Keep the MIT license and T3 Code attribution.
