# Cox & CoCode Website Design System

Scope: the static product website in `site/` (Cox homepage at `/`, CoCode subpage at `/cocode/`).
This document is the single source of truth for tokens, layout, components and motion. The
application UI in `apps/web` is out of scope. Every value below is consumed as a CSS custom
property; component CSS must never hardcode colors, spacing, type sizes, radii or durations.

Hard constraints inherited from `site/README.md` and the root `AGENTS.md`:

- No external fonts, analytics, CDNs, frameworks or runtime dependencies. Vanilla HTML, CSS and ES modules only.
- All asset paths are relative so the build works at `/`, `/cox/` and `/cocode/`.
- Icons come from the inline SVG sprite (`<svg class="icon"><use href="#i-name" /></svg>`), never Unicode symbol glyphs.
- Visible text is 12px or larger; Chinese text never receives negative letter spacing.
- The workspace illustration is illustrative only; no control starts an agent or sends a prompt.
- Bilingual (zh-CN / en) content with readable Chinese HTML fallback; launch commands, paths and provider names are never translated.
- No emojis anywhere in markup, copy or code.

---

## 0. Research Log

| Lane | Sources consulted | Decision |
| --- | --- | --- |
| Embedded references | Shortlisted linear.app, vercel, supabase. | Picked `redesign-skill.md` + `ambience-skill.md` + `interaction-skill.md` + `linear.app.md`. Linear's luminance-stepped dark surfaces, hairline borders and dense product-shot hero are adapted with Cox's botanical phosphor lime (`#b7ed81` dark / `#256f18` light) and CoCode's warm amber (`#efc56f` dark / `#8a4f00` light). Vercel was rejected (monochrome, no brand hue to carry); Supabase was rejected (its green is too close to Cox lime and would read as a clone). |
| StyleGallery | https://raw.githubusercontent.com/changeroa/StyleGallery/main/CATALOG.md | Selected `page-grid`, `split-screen`, `tab-strip`, `dense-grid`, `stack`. Homepage composes page-grid + split-screen + tab-strip (dense-grid inside the bento); CoCode composes split-screen + stack. |
| Ambience catalog | https://reactbits.dev/r/ShapeGrid-TS-TW.json | Lattice concept only. Re-implemented as a zero-dependency 2D canvas lattice for the hero (section 6). No React, no Tailwind, no copied source. |
| Interaction catalog | https://reactbits.dev/r/SpotlightCard-TS-TW.json, https://beui.dev/r/tabs/raw | SpotlightCard became the pointer-tracked `--mx/--my` radial wash on bento cards; the beui tabs pattern became the ARIA tablist + panel used by the workflow inspector. Both re-implemented in vanilla JS/CSS. |
| Skipped lanes | Lazyweb, Imagen drafts | Skipped: this is a redesign of an existing product website, so the baseline is the live before captures in `/tmp/tmp.oUaEAYE4nf/evidence-before/` (home and CoCode, desktop 1440 and iPhone 14, dark and light, top and end). |

Baseline facts extracted from the current code (salvaged, not discarded):

- `site/styles.css`: dark-only (`color-scheme: dark`), tokens `--background #090b0a`, `--foreground #f3f5ef`, `--muted #929a91`, `--accent #b7ed81`, `--add #9cdea9`, `--del #f2a094`, system `--sans` with CJK fallbacks, `--mono`, 1280px `.wrap`, breakpoints 380/640/900/1100, container queries on the demo window (680/1060/520), focus ring `2px solid var(--accent)` with offset.
- `site/cocode/styles.css`: already has dark + light (`[data-theme]` and `prefers-color-scheme`), amber `--accent #efc56f`, 4px spacing scale, `--text-*` scale, `--radius-*`, `--fast 0.16s`, `--slow 0.6s`, `--ease cubic-bezier(0.2, 0.7, 0.2, 1)`.
- The two pages diverge in token names (`--background` vs `--canvas`, `--muted` vs `--ink-muted`). This system unifies them under one vocabulary; CoCode differs only in the accent family.

---

## 1. Atmosphere & Identity

**"Precision Command Cockpit."** Cox is the place where several coding agents are steered from one
local console. The site should feel like an instrument panel at night: obsidian, quiet, exact, with
one phosphor signal color that only lights up where something is live or actionable.

- **Dark (default "Obsidian")**: luminance-stepped surfaces `#070908` (canvas) -> `#0d110f` (surface) -> `#131916` (elevated) -> `#1a221d` (inset/raised control). Depth comes from stepping luminance, not from shadows or blur.
- **Light ("Mineral Daylight")**: `#f5f7f3` (canvas) -> `#ffffff` (surface) -> `#edf2ea` (inset). Crisp, faintly green-mineral neutrals; never pure gray, never cream.
- **Signal**: phosphor botanical lime `#b7ed81` on dark, deepened to `#256f18` on light so it remains a text-grade color (5.49:1 minimum).
- **CoCode sibling identity**: the same cockpit, handheld. Identical neutrals and structure, accent swapped to warm amber `#efc56f` dark / `#8a4f00` light, with Cox lime appearing only as a cross-reference to the parent product.
- **Voice of the visuals**: monospace for anything a machine would print (commands, ports, branch names, diff counts, DAG node ids); geometric sans for human statements. Real product nouns (OMO Native, CLIProxyAPI, worktrees, checkpoints, `127.0.0.1`) instead of abstract marketing shapes.
- **Not this**: purple gradients, glassmorphism blur walls, neon glow stacks, stock illustrations, fabricated social proof.

---

## 2. Color

Theme selection: `:root` defaults to the user's `prefers-color-scheme`; an explicit choice sets
`:root[data-theme="dark"|"light"]` and persists as `cox.site.theme` / `cocode.site.theme`.
`color-scheme` follows the active theme so form controls and scrollbars match.

### 2.1 Core tokens (Cox homepage)

Contrast ratios are measured against every background the token may sit on
(canvas / surface / elevated / inset for dark; canvas / surface / inset for light). The lowest value is listed.

| Token | Role | Dark | Light | Min contrast dark / light |
| --- | --- | --- | --- | --- |
| `--bg-canvas` | Page background | `#070908` rgb(7 9 8) | `#f5f7f3` rgb(245 247 243) | n/a |
| `--bg-surface` | Cards, header on scroll, window body | `#0d110f` rgb(13 17 15) | `#ffffff` rgb(255 255 255) | n/a |
| `--bg-elevated` | Cockpit window, popovers, toast | `#131916` rgb(19 25 22) | `#ffffff` rgb(255 255 255) | n/a |
| `--bg-inset` | Command pill, code blocks, segmented track, sidebar | `#1a221d` rgb(26 34 29) | `#edf2ea` rgb(237 242 234) | n/a |
| `--text-primary` | Headings, body | `#f3f5ef` rgb(243 245 239) | `#121712` rgb(18 23 18) | 14.81 / 15.98 |
| `--text-secondary` | Lead, descriptions | `#b6beb3` rgb(182 190 179) | `#3e493f` rgb(62 73 63) | 8.53 / 8.29 |
| `--text-muted` | Captions, metadata, timestamps | `#8f998e` rgb(143 153 142) | `#58635a` rgb(88 99 90) | 5.51 / 5.52 |
| `--border-subtle` | Decorative hairlines inside surfaces | `rgb(238 243 235 / 8%)` | `rgb(18 23 18 / 8%)` | decorative, no requirement |
| `--border-default` | Card and window edges | `rgb(238 243 235 / 14%)` | `rgb(18 23 18 / 14%)` | decorative; card meaning never relies on edge alone |
| `--border-strong` | Control boundaries, inputs, focus-adjacent UI edges | `#66736a` rgb(102 115 106) | `#7f8b80` rgb(127 139 128) | 3.27 / 3.13 (>= 3:1 UI) |
| `--accent` | Primary action fill, active tab marker, focus ring, links | `#b7ed81` rgb(183 237 129) | `#256f18` rgb(37 111 24) | 11.97 / 5.49 |
| `--accent-hover` | Hover/pressed primary | `#c9f59d` rgb(201 245 157) | `#1c5a11` rgb(28 90 17) | 13.20 / 7.34 |
| `--accent-ink` | Text/icons on `--accent` fill | `#102008` rgb(16 32 8) | `#ffffff` rgb(255 255 255) | 12.53 on accent / 6.24 on accent |
| `--accent-wash` | Selected row, spotlight tint, badge fill | `rgb(183 237 129 / 12%)` | `rgb(37 111 24 / 10%)` | background only; text on it uses `--text-primary` or `--accent` |
| `--cyan-signal` | Gateway / protocol / network nodes | `#7fd8e6` rgb(127 216 230) | `#0a6676` rgb(10 102 118) | 9.97 / 5.82 |
| `--amber-signal` | Queue, pending, warnings, CoCode cross-link | `#efc56f` rgb(239 197 111) | `#8a4f00` rgb(138 79 0) | 9.99 / 5.78 |
| `--status-add` | Diff additions, passed checks | `#9cdea9` rgb(156 222 169) | `#1d7135` rgb(29 113 53) | 10.41 / 5.34 |
| `--status-del` | Diff deletions, failures | `#f2a094` rgb(242 160 148) | `#b42318` rgb(180 35 24) | 7.93 / 5.79 |

Supporting tokens (derived, still tokens):

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--header-bg` | `rgb(7 9 8 / 78%)` | `rgb(245 247 243 / 82%)` | Sticky header after scroll |
| `--shadow-tint` | `rgb(0 0 0 / 55%)` | `rgb(28 44 24 / 14%)` | Elevation shadow color (section 7) |
| `--lattice-dot` | `rgb(183 237 129 / 16%)` | `rgb(37 111 24 / 14%)` | Hero canvas lattice |
| `--lattice-glow` | `rgb(183 237 129 / 45%)` | `rgb(37 111 24 / 35%)` | Lattice hover/pulse cells |
| `--selection-bg` / `--selection-ink` | `--accent` / `--accent-ink` | `--accent` / `--accent-ink` | `::selection` |

### 2.2 CoCode accent override (`/cocode/`)

CoCode reuses every neutral, border and status token above unchanged and overrides only:

| Token | Dark | Light | Min contrast dark / light |
| --- | --- | --- | --- |
| `--accent` | `#efc56f` | `#8a4f00` | 9.99 / 5.78 |
| `--accent-hover` | `#f6d48f` | `#723f00` | > 9.99 / 7.62 |
| `--accent-ink` | `#231a09` | `#ffffff` | 10.54 / 6.56 |
| `--accent-wash` | `rgb(239 197 111 / 12%)` | `rgb(138 79 0 / 10%)` | background only |
| `--cox-crosslink` | `#b7ed81` | `#256f18` | Same as Cox `--accent`, used only for "Cox" references |

### 2.3 Rules

- One accent per viewport region. Signal colors (`--cyan-signal`, `--amber-signal`, `--status-*`) are semantic, never decorative.
- Color is never the only carrier of meaning: diff counts keep `+`/`-`, statuses keep a text label or icon.
- Gradient text is allowed only on the single hero accent line, from `--accent` to `--accent-hover`; both stops pass contrast on their own.
- No hardcoded hex in component CSS. New colors are added here first, with both theme values and a measured ratio.

---

## 3. Typography

No web fonts are loaded. Distinctiveness comes from tight display tracking, weight contrast and the
monospace voice, not from a downloaded face.

```css
--font-sans:
  "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display",
  "Segoe UI", system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC",
  "Source Han Sans SC", sans-serif;
--font-mono:
  ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Code", Menlo, Consolas, "Liberation Mono",
  "Noto Sans Mono CJK SC", monospace;
```

### 3.1 Scale

Each heading step is at least 1.25x the next one at both ends of the clamp.

| Token | Role | Size (min -> max) | Line height | Weight | Tracking (Latin) | Ratio to next |
| --- | --- | --- | --- | --- | --- | --- |
| `--type-display` | Hero headline | `clamp(48px, 6.4vw + 8px, 96px)` | 1.0 | 680 | -0.045em | 1.33 / 1.60 |
| `--type-h1` | Section headline | `clamp(36px, 3.6vw + 10px, 60px)` | 1.08 | 650 | -0.035em | 1.29 / 1.50 |
| `--type-h2` | Sub-section, bento lead card title | `clamp(28px, 2.2vw + 8px, 40px)` | 1.15 | 620 | -0.025em | 1.27 / 1.67 |
| `--type-h3` | Card title, panel title | `clamp(22px, 0.6vw + 18px, 24px)` | 1.25 | 600 | -0.012em | 1.16 / 1.26 to Lead |
| `--type-lead` | Hero lead, section intro | `clamp(17px, 0.4vw + 15px, 19px)` | 1.6 | 400 | 0 | 1.06 / 1.19 |
| `--type-body` | Body copy | `16px` | 1.6 | 400 | 0 | 1.14 |
| `--type-small` | Card descriptions, nav, button labels | `14px` | 1.5 | 450 | 0 | 1.17 |
| `--type-caption` | Metadata, code, chips, window chrome | `12px` | 1.45 | 450 | 0.01em | floor |

Note on H3 -> Lead: H3 and Lead never sit adjacent as hierarchy peers (Lead follows H1/Display only),
so the 1.25x rule is enforced across Display, H1, H2, H3 and between H3 and Body (22/16 = 1.375).

### 3.2 Rules

- **Minimum 12px** for all visible text, including window chrome, DAG node labels, chips and footer. Illustrations shrink by dropping panes (container queries), never by shrinking type.
- **CJK**: `:lang(zh) { letter-spacing: 0; }` on every element that carries negative tracking. Chinese display headlines use weight 600 and line-height 1.12 to avoid ascender collisions.
- **Numerals**: `font-variant-numeric: tabular-nums` on metrics, diff counts, ports, timestamps, version numbers, DAG progress (`4/4`) and step numbers.
- **Monospace** (`--font-mono`, `--type-caption` or `--type-small`) for commands, paths, branch names, ports, model ids, node ids. Never translated.
- Measure: body text max `68ch`; lead max `60ch`; headlines `text-wrap: balance`, paragraphs `text-wrap: pretty`.
- Weights are limited to 400, 450, 600, 620, 650, 680; fall back gracefully on fonts without variable axes.

---

## 4. Spacing & Layout

### 4.1 Spacing scale (4px base)

| Token | Value | Token | Value |
| --- | --- | --- | --- |
| `--space-1` | 4px | `--space-10` | 40px |
| `--space-2` | 8px | `--space-12` | 48px |
| `--space-3` | 12px | `--space-16` | 64px |
| `--space-4` | 16px | `--space-20` | 80px |
| `--space-5` | 20px | `--space-24` | 96px |
| `--space-6` | 24px | `--space-28` | 112px |
| `--space-8` | 32px | `--space-32` | 128px |

Section rhythm: `--section-gap: clamp(var(--space-20), 10vw, var(--space-32))` between top-level sections;
`--space-12` between a section header and its content; `--space-4`/`--space-6` inside cards.

### 4.2 Container and grid

- `--container-max: 1280px`; `--gutter: clamp(var(--space-4), 4vw, var(--space-10))`.
- `.wrap { width: min(var(--container-max), 100% - 2 * var(--gutter)); margin-inline: auto; }`
- Page grid: 12 columns, `column-gap: var(--space-6)` (desktop), collapsing to 6 columns at <= 900px and 1 column at <= 640px.

### 4.3 Breakpoints

| Token | Width | Behavior |
| --- | --- | --- |
| `--bp-xs` | 320px | Floor. No horizontal overflow; command pill wraps; phone frame scales to fit. |
| `--bp-sm` | 390px | Typical phone. Hero actions stack full-width below this. |
| `--bp-md` | 640px | Bento becomes 2 columns; tab strip stops scrolling horizontally. |
| `--bp-lg` | 900px | Split-screen sections go side by side; nav links show. |
| `--bp-xl` | 1100px | Bento reaches its asymmetric 6-column arrangement; cockpit shows 3 panes when its container allows. |
| `--bp-2xl` | 1440px | Max design width; extra space becomes margin, never wider content. |

Media queries use `min-width` mobile-first. The cockpit window uses container queries
(`container: cockpit / inline-size`) at 560px (2 panes) and 960px (3 panes), independent of viewport.

### 4.4 Layout lines (StyleGallery)

Layout: Cox Homepage (#top) - narrative product showcase with interactive cockpit stage, asymmetric bento architecture, and tabbed workflow inspector -> page-grid + split-screen + tab-strip (https://raw.githubusercontent.com/changeroa/StyleGallery/main/CATALOG.md); scroll owner: document; anti-patterns: nested vertical scrollbars inside cards, horizontal overflow at 320px, equal-height 3-card generic row, coloured 4px left stripes

Layout: CoCode Subpage (/cocode/) - mobile-runtime showcase with device frame and 2-column capability matrix -> split-screen + stack (https://raw.githubusercontent.com/changeroa/StyleGallery/main/CATALOG.md); scroll owner: document; anti-patterns: clipped phone frame on 320px, root-relative asset paths, Unicode symbol glyph icons

### 4.5 Homepage section map

1. Header (sticky, transparent until scroll, then `--header-bg` + `--border-subtle` bottom hairline).
2. Hero: page-grid, headline + lead + actions + command pill, then full-width cockpit stage over the canvas lattice.
3. Signature Capabilities: asymmetric bento (dense-grid inside page-grid). Desktop arrangement on 6 columns: OMO Native DAG & Memory spans 4 cols x 2 rows; CLIProxyAPI Gateway 2 x 1; Queue & Steer 2 x 1; Git Worktrees & Checkpoints 6 x 1 (wide strip with a branch/checkpoint timeline). No two cards share the same footprint in a row.
4. Workflow inspector: tab-strip (Agents / Queue and steer / Changes and checkpoints / Terminal and Git) on the left, live panel on the right (split-screen at >= 900px, stacked below). All views share one grid cell so switching never changes the panel height.
5. Desktop + CoCode + Local-first topology: split-screen; left copy, right topology diagram (Browser / Desktop / CoCode -> `127.0.0.1` Cox server -> agents -> configured model services).
6. Quick Start: three steps in a stack with copyable commands.
7. Footer: license, attribution, language and theme switchers.

---

## 5. Components + Screen Briefs

All components are plain HTML + CSS + small ES module behaviors. Class names stay flat and
descriptive (existing convention: `.button`, `.button-primary`, `.segmented`, `.window`, `.command`).

### 5.1 Command Button

- Variants: `.button-primary` (fill `--accent`, ink `--accent-ink`), `.button-secondary` (fill `--bg-inset`, 1px `--border-strong`, ink `--text-primary`), `.button-ghost` (transparent, ink `--text-secondary`, hover `--accent-wash`).
- Box: height `--control-h` (44px; 40px for compact header buttons with a 44px hit area via padding), padding-inline `--space-5`, radius `--radius-sm`, gap `--space-2`, label `--type-small` weight 600, trailing sprite icon 16px.
- **State-stable box**: hover, active, focus and loading never change width, height, border width or font weight. Hover changes fill to `--accent-hover`; active translates `0 1px`; borders are always 1px (transparent on primary) so variants align on the same baseline.
- Focus: `outline: 2px solid var(--accent); outline-offset: 3px` (`--focus-ring`).
- Icon-only buttons carry `aria-label`; external links get the `#i-arrow-up-right` sprite plus visually hidden "(opens in new tab)" text when `target="_blank"`.

### 5.2 Segmented Agent / Theme Switcher

- Track: `--bg-inset`, 1px `--border-subtle`, radius `--radius-md`, padding `--space-1`.
- Segments: a labelled `role="group"` of toggle buttons with `aria-pressed` (agent: OMO / Codex / Claude / Cursor), height 36px, radius `--radius-sm` (concentric: 12 - 4 = 8), `--type-caption` or `--type-small`. The theme control is a single cycling button (System, Light, Dark) whose accessible name states the current mode.
- Selected: `--bg-elevated` fill, `--text-primary`, 1px `--border-default`, plus provider sprite icon; unselected: `--text-muted`.
- Arrow keys move selection, Home/End jump; the selected segment is the only tab stop (roving tabindex).
- The selection indicator slides with `transform` only (section 6). Labels never reflow on selection.

### 5.3 Interactive Cockpit Window

- `container: cockpit / inline-size`. Chrome bar (dots, `127.0.0.1:4773` URL pill in mono with `#i-lock` sprite, LIVE badge) on `--bg-inset`.
- 1 pane (< 560px container): conversation timeline only. 2 panes (>= 560px): + sidebar of projects/threads. 3 panes (>= 960px): + changes panel (diff file list with `--status-add`/`--status-del` tabular counts).
- **Live DAG strip** pinned under the chrome bar: OMO wave nodes (`plan.contracts`, `impl.gateway`, `impl.cockpit` -> `verify`) as mono chips connected by 1px SVG paths in `--border-strong`; running nodes pulse `--accent-wash`; done nodes show `#i-check` in `--status-add`; progress `4/4` in tabular nums. Collapses to a single "Wave 1 - 3 parallel - 4/4" line under 560px.
- Agent switcher (5.2) swaps the illustrated transcript, model chip and DAG labels; it is explicitly labeled "Illustrative" and never sends anything.
- Text inside stays >= 12px at every width; content inside never scrolls vertically (fixed illustrative content sized to fit).
- Surface: `--bg-elevated`, radius `--radius-xl`, 1px `--border-default`, elevation `--elevation-hero` (section 7).

### 5.4 Spotlight Bento Card

- Surface `--bg-surface`, 1px `--border-default` hairline on all four sides, radius `--radius-lg`, inner media radius `--radius-md` (concentric rule in 7.2).
- Pointer-tracked wash: `::before` with `background: radial-gradient(420px circle at var(--mx) var(--my), var(--accent-wash), transparent 70%)`, `pointer-events: none`, `opacity` 0 -> 1 on hover; `--mx/--my` set via rAF-throttled `pointermove` (section 6).
- Anatomy: sprite icon (20px, `--accent` or the card's semantic signal color), title `--type-h3`, description `--type-small` in `--text-secondary`, embedded mini-visual (DAG, protocol switchboard, queue list, branch timeline) built from tokens.
- **Zero 4px side stripes.** No colored left border, no top accent bar. Emphasis comes from footprint and the mini-visual.
- Whole card is not a link unless it has a single destination; then the title link uses the stretched-link pattern and the card shows the focus ring on `:focus-within`.

### 5.5 Workflow Tablist + Panel

- `role="tablist"` with `aria-orientation="vertical"` at >= 900px and horizontal below; tabs are `role="tab"` with `aria-controls`, panels `role="tabpanel"` with `tabindex="0"`.
- Tab: full-width row, `--type-small` title + `--type-caption` hint in `--text-muted`, step number in mono tabular nums (not a section kicker). Selected: `--bg-elevated` fill, 1px `--border-default`, title in `--text-primary` and step number in `--accent`, plus `aria-selected="true"`. Under 640px (horizontal) a 2px `--accent` bottom underline is added. No leading side bar in either orientation.
- Arrow keys move focus and activate (automatic activation), Home/End supported. Panels crossfade with opacity only; panel height is reserved by a grid stack (`grid-area: 1 / 1` for all panels) so the page never jumps.
- Under 640px the tablist scrolls horizontally inside itself with `scroll-snap-type: x mandatory` and visible edge fades; this is the only permitted inner scroller and it is horizontal.

### 5.6 Copyable Command Pill + Accessible Toast

- Pill: `--bg-inset`, 1px `--border-strong`, radius `--radius-md`, mono `--type-small`, prompt `$` in `--text-muted` (`aria-hidden`), command in `--text-primary`, copy button (icon-only, 36px, `aria-label="Copy command"`).
- At <= 390px the command wraps with `overflow-wrap: anywhere`; it never overflows horizontally.
- Copy feedback: icon swaps `#i-copy` -> `#i-check` for 1.6s with stable button size, and a toast region (`role="status"`, `aria-live="polite"`, one per page) announces "Copied" / "Copy failed - select the text manually". Toast: `--bg-elevated`, 1px `--border-default`, radius `--radius-md`, `--elevation-1`, bottom-center, enters with opacity + translateY(8px -> 0).
- Clipboard failure keeps the command selectable and is reported, never swallowed.

### 5.7 Screen Brief: Cox Homepage (`/`)

- **Primary action**: Download Cox Desktop (links to the GitHub Releases desktop builds). Secondary: View on GitHub. Tertiary: copy `npx @doublepi123/cox@latest`.
- **Priorities**:
  1. Hero headline + 4-agent interactive cockpit (OMO, Codex, Claude, Cursor) & the npx launch command.
  2. Signature Capabilities Bento: OMO Native DAG & Memory; CLIProxyAPI Local Model Gateway; Real-time Queue & Steer; Git Worktrees & Checkpoints.
  3. Desktop + CoCode + Local-first topology & Quick Start.
- **Left out on purpose**: numbered 01-05 section kickers above every heading; fabricated testimonials and vanity user stats; glassmorphism clone blur walls; 4px coloured side-stripes.
- **Required content**:
  - Header: Cox mark (`assets/cox.svg`), nav (Capabilities, Workflow, Desktop, Local first, Quick start), language switch (zh/en), theme switch (System/Light/Dark), GitHub link.
  - Hero: status line "MIT open source - runs on 127.0.0.1", headline (en "Your agents. One cockpit." / zh equivalent), lead naming Codex, Claude Code, Cursor, OMO Native, OpenCode and Pi, Download + GitHub actions, command pill, platform note "macOS / Windows desktop - npm for browser - bring your own agent account or API".
  - Cockpit stage with agent switcher, live DAG strip, diff panel, `Illustrative` label.
  - Bento copy grounded in README facts: OMO native task DAG with waves/critical path, shared instance memory under Cox state; CLIProxyAPI translator for OpenAI Responses / Chat Completions / Anthropic Messages / Gemini with keys kept in the local secret store; queue by default with Steer now and reorderable queue; worktrees, checkpoints and Move to project.
  - Workflow tabs: Agents, Queue and steer, Changes and checkpoints, Terminal and Git.
  - Desktop section: combined vs client-only installers, staged backend updates with rollback, HTTPS + password remote connection.
  - CoCode cross-link card (amber `--amber-signal`) linking `./cocode/`.
  - Local-first topology with the explicit statement that local control is not offline inference.
  - Quick Start: `npm install --global @doublepi123/cox@latest`, `cox`, configure provider in Settings.
  - Footer: MIT license, T3 Code attribution. The site draws its own OMO glyph and does not ship the separately licensed official OmO icon, so no OmO icon notice is needed; add one if that icon is ever used here.

### 5.8 Screen Brief: CoCode Subpage (`/cocode/`)

- **Primary action**: Download Android APK (GitHub Releases). Secondary: Explore Cox for desktop (`../`).
- **Priorities**:
  1. Split-screen hero: headline "Your coding workspace in your pocket" + lead + actions on the left; device frame with the illustrative mobile cockpit on the right (stacks below copy under 900px).
  2. 2-column capability matrix (stack on mobile): runs Cox locally on the phone, no computer or root, uses configured agents, local `127.0.0.1` server, same threads/terminals/diffs, bilingual.
  3. How it works (3 steps in a stack) + Download block with Android version requirement and prerelease note.
- **Left out on purpose**: Unicode symbol glyph icons (arrows, check marks, dots as text), app-store badges, fake ratings, a clipped phone frame at 320px, root-relative asset paths.
- **Required content**: CoCode icon (`cocode/icon.png`), header with language + theme switch, "Cox on Android" status line, device frame (status bar, project card, transcript, task checklist using `#i-check` sprite, footer "Cox running on this device - 127.0.0.1" in mono), `Illustrative interface` caption, capability matrix, steps, download, MIT license + upstream NOTICE links (`./LICENSE`, `./NOTICE`).
- **Device frame**: width `min(100%, 320px)` at mobile with `aspect-ratio: 9 / 19.5`, radius `--radius-device` (44px), frame gradient from neutral tokens; at 320px viewport it scales to `calc(100vw - 2 * var(--gutter))` and is never clipped.

---

## 6. Motion & Interaction

### 6.1 Timing tokens

| Token | Value | Use |
| --- | --- | --- |
| `--dur-instant` | 90ms | Press feedback |
| `--dur-fast` | 160ms | Hover color/fill, focus ring |
| `--dur-base` | 240ms | Segmented indicator, tab panel crossfade, toast |
| `--dur-slow` | 480ms | Section reveal |
| `--dur-ambient` | 2400ms | DAG node pulse cycle |
| `--ease-out` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | Default (matches existing `--ease`) |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Indicator slides |
| `--stagger` | 60ms | Reveal stagger between siblings, max 6 steps |

### 6.2 Hero lattice (ShapeGrid-inspired, 2D canvas)

- One `<canvas aria-hidden="true">` behind the hero, `position: absolute; inset: 0; pointer-events: none`. Square lattice at 24px pitch, dots in `--lattice-dot`, radially masked so it fades toward the edges and under the headline.
- Ambient: a slow diagonal wave brightens cells to `--lattice-glow`; pointer proximity (desktop, `pointer: fine` only) lifts nearby cells. Colors read from computed CSS variables and re-read on theme change.
- Runs only while visible: `IntersectionObserver` starts/stops the rAF loop; `visibilitychange` pauses when the tab is hidden; DPR capped at 2; resize handled by `ResizeObserver`.
- `prefers-reduced-motion: reduce`: draw a single static frame, no loop, no pointer response.
- If canvas or JS is unavailable, the hero renders unchanged on the plain `--bg-canvas` (progressive enhancement).

### 6.3 Spotlight wash

- `pointermove` on the bento grid (delegated), writes `--mx`/`--my` in px on the hovered card at most once per animation frame (rAF throttle). The wash layer has `pointer-events: none` and animates only `opacity`.
- Disabled for `pointer: coarse` and reduced motion (the wash is simply not shown).

### 6.4 Rules

- Movement animates only `transform` and `opacity` (compositor-only). Short hover and state transitions may also change `color`, `background-color` and `border-color`. Never animate width, height, top/left, box-shadow, filter or backdrop-filter.
- Content is visible by default. Reveal-on-scroll adds `opacity`/`translateY(12px)` only after JS marks the element as below the fold, so screenshots, no-JS visitors and printing never see faded content.
- No motion loops longer than 5s without a pause control except the paused-when-offscreen lattice and the DAG pulse (both decorative, `aria-hidden`, disabled under reduced motion).
- `prefers-reduced-motion: reduce` sets all `--dur-*` to `0.01ms`, disables smooth scroll and stagger.

---

## 7. Depth & Surface

### 7.1 Depth model

1. **Luminance stepping** first: canvas -> surface -> elevated -> inset, each step one token (section 2). On light, surface is white over the mineral canvas and inset is a recessed tint.
2. **1px translucent hairlines** (`--border-subtle`, `--border-default`) define edges; `--border-strong` only for interactive control boundaries.
3. **Tinted y-offset elevation** only where a surface floats over content:

| Token | Value | Use |
| --- | --- | --- |
| `--elevation-1` | `0 1px 2px var(--shadow-tint)` | Toast, popovers, selected segment |
| `--elevation-2` | `0 8px 24px -12px var(--shadow-tint)` | Hovered bento card (applied via a pre-rendered pseudo-element whose opacity animates) |
| `--elevation-hero` | `0 40px 80px -40px var(--shadow-tint), 0 0 0 1px var(--border-default)` | Cockpit window and CoCode device frame only |

- A top-lit inner highlight on the cockpit window: `inset 0 1px 0 rgb(255 255 255 / 6%)` on dark, omitted on light.
- No `backdrop-filter` except the sticky header (`blur(12px)` over `--header-bg`), which degrades to the opaque-ish background when unsupported.

### 7.2 Concentric radii

| Token | Value | Use |
| --- | --- | --- |
| `--radius-xs` | 6px | Chips, DAG node chips, kbd |
| `--radius-sm` | 8px | Buttons, segments, inner media in compact cards |
| `--radius-md` | 12px | Command pill, segmented track, toast, inner media in bento cards |
| `--radius-lg` | 16px | Bento cards, tab panel |
| `--radius-xl` | 20px | Cockpit window, topology frame |
| `--radius-device` | 44px | CoCode device frame |
| `--radius-pill` | 999px | Status badges, LIVE badge |

Concentric rule: inner radius = outer radius - padding between them, snapped to the nearest token
(segmented track 12px with 4px padding -> segment 8px; bento card 16px with 4px media inset -> 12px;
cockpit 20px with 8px gutter -> inner panes 12px).

---

## 8. Accessibility Constraints & Accepted Debt

Target: WCAG 2.2 AA on both themes, both languages, from 320px to 1440px+.

- **Contrast**: body text >= 4.5:1, large text (>= 24px, or >= 18.66px bold) >= 3:1, UI component boundaries and focus indicators >= 3:1. All token pairs in section 2 are measured; new pairs must be measured before use.
- **Focus**: `:focus-visible` ring `2px solid var(--accent)` with `outline-offset: 3px` on every interactive element (focus ring >= 3:1 against adjacent colors: 11.97 dark / 5.49 light). Never `outline: none` without a replacement. Sticky header uses `scroll-padding-top` so focused targets are not obscured (2.4.11).
- **Keyboard**: skip link to `#main`; segmented switchers and tablists use roving tabindex with arrow/Home/End; all copy actions reachable; no keyboard traps.
- **Target size**: interactive targets >= 24x24 CSS px (2.5.8), primary controls 44px tall.
- **Reflow**: no horizontal scrolling at 320px (1.4.10); the only horizontal scroller is the tab strip under 640px, which is itself fully reachable by keyboard.
- **Text spacing**: layouts survive line-height 1.5, paragraph spacing 2em, letter spacing 0.12em, word spacing 0.16em without clipping (no fixed heights on text containers).
- **State-stable controls**: no layout shift on hover, focus, selection, language switch or theme switch; reserved heights for tab panels and copy feedback.
- **Semantics**: one `h1` per page; landmarks (`header`, `nav`, `main`, `footer`); decorative canvas and SVG illustrations `aria-hidden`; illustrated UI labeled "Illustrative"; language switch updates `<html lang>`.
- **Motion**: honors `prefers-reduced-motion` (section 6).
- **Theme**: honors `prefers-color-scheme`, `forced-colors: active` keeps borders visible via `CanvasText`/`Highlight` system colors.

### Accepted debt

| ID | Item | Reason | Owner | Revisit by |
| --- | --- | --- | --- | --- |
| (none) | | | | |

---

## 9. Ideal State & Gap Ledger

**Ideal state**: a visitor on any device, in either language and either theme, understands within
one screen that Cox is a local cockpit for many coding agents, sees the four differentiators
(OMO DAG & memory, local model gateway, queue & steer, worktrees & checkpoints) demonstrated rather
than listed, can copy the launch command or download the desktop app, and finds CoCode as the
handheld sibling with the same visual language. Every surface is token-driven and passes AA.

Baseline evidence: `/tmp/tmp.oUaEAYE4nf/evidence-before/` (16 captures: home and CoCode x desktop 1440 / iPhone 14 x dark / light x top / end).

| ID | Gap (observed in baseline) | Evidence | Fix | Proof of done |
| --- | --- | --- | --- | --- |
| G1 | Homepage never mentions OMO Native, its task DAG or shared memory, Cox's strongest differentiator. | `home-desktop-1440-dark-*-before.png`; no OMO copy in `site/index.html` | Bento lead card "OMO Native DAG & Memory" (4x2) with live DAG mini-visual; DAG strip in the cockpit window (5.3, 5.4). | After-capture shows the card and DAG strip in both languages; case-insensitive `grep -c omo` on `site/index.html` and `site/content.js` is > 0 (baseline 0). |
| G2 | The local model gateway appears only as a one-line "own API gateway" mention; CLIProxyAPI protocol translation and locally held upstream keys are never explained. | Same captures; `site/content.js` keys `feature.providers.*` and quick-start step only, zero `CLIProxy` matches | Bento card "CLIProxyAPI Local Model Gateway" with protocol switchboard (OpenAI Responses / Chat / Anthropic / Gemini) in `--cyan-signal`. | After-capture shows the card; copy matches README claims (no offline-inference claim). |
| G3 | Homepage is dark-only: the light captures are identical to the dark ones (`color-scheme: dark`, no light tokens). | `home-*-light-*-before.png` vs `home-*-dark-*-before.png` | Full Mineral Daylight token set (section 2), `prefers-color-scheme` default + persisted System/Light/Dark switch. | Light after-captures differ from dark; automated contrast check of token pairs passes AA in both themes. |
| G4 | Unicode-symbol icon risk on CoCode. Source audit: the current arrows and checks are already SVG sprites (`#i-arrow-up-right`, `#i-check`), and the status dots are CSS pseudo-elements. The gap is that the CoCode sprite is maintained separately from the homepage sprite and no check guards the no-glyph rule. | `cocode-*-top-before.png`; `site/cocode/index.html` sprite block; `site/cocode/styles.css` `content: ""` dots | Keep and share one sprite vocabulary (same ids and stroke style as the homepage), draw status dots as token-colored shapes, and never introduce symbol glyphs in redesigned markup or `content.js` strings. | No code points in U+2190-U+27BF or U+2B00-U+2BFF in `site/cocode/index.html`, `site/cocode/main.js`, `site/index.html` or `site/content.js`; after-capture shows SVG icons only. |
| G5 | Repetitive numbered kickers (`01`-`05` eyebrows, `A / 02` detail index, `workflow-number`, `step-number`) above every section add noise without meaning. | `site/index.html` lines with `<span>01</span>` ... `<span>05</span>`; home end captures | Remove section number kickers; keep step numbers only inside the Quick Start stack and workflow tabs where order is real. | `grep` finds no `<span>0N</span>` eyebrow pattern; after-captures show plain headings. |
| G6 | Diagrams (workflow, local-first) are flat static illustrations; the cockpit lacks live state. | Home desktop end captures | Live DAG strip with pulse, agent switcher driving transcript/DAG, tabbed workflow inspector with live panels, topology diagram with animated (reduced-motion-safe) flow. | Interaction checks: switching agent/tab updates the illustration; reduced-motion run shows a static frame. |
| G7 | Hero content is captured nearly invisible at load (reveal animation starts from `opacity: 0`), so the first screen reads as an empty dark page. | `home-desktop-1440-dark-top-before.png`, `home-iphone-14-dark-end-before.png` | Visible-by-default rule (6.4): hero never animates from zero opacity; reveal only for below-fold content after JS opt-in. | Top after-capture at 1440 and iPhone 14 shows full-contrast headline and actions. |
| G8 | Two pages use divergent token vocabularies and scales (`--background`/`--muted` vs `--canvas`/`--ink-muted`; radii 4-16 vs none), and the homepage hardcodes sizes and radii. | `site/styles.css` `:root`, `site/cocode/styles.css` `:root` | Both stylesheets consume the shared token names in this document; CoCode overrides only the accent family (2.2). | `grep` of component rules finds no raw hex outside `:root`/theme blocks; the 12px minimum-text browser test passes. |
