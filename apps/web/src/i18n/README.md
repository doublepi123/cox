# Interface languages

Cox chooses the first supported language in `navigator.languages`: Chinese (`zh`, including
regional variants) or English (`en`). Unsupported devices fall back to English. The General
settings page offers a persisted override or the device-language default (`cox.language`).
Changes update mounted interface components without remounting the workspace or losing drafts.
Device language changes and preferences changed in another browser tab update the interface too.

`en.ts` and `zh.ts` are the interface resources. English source strings are stable translation
keys. Components use `useTranslation()` for interface-owned labels only. Do not translate
messages, agent responses, prompts, source code, file paths, project names or provider output.
Use explicit interpolation values for dynamic interface text; never replace text in the DOM.

Core navigation, local agent onboarding, projects, chat actions and settings are translated.
Confirmation dialogs, bulk thread actions, queued-message controls, custom snooze, usage
filters and common provider/model/theme settings use the same resources. Confirmation
titles use explicit placeholders so thread titles are preserved, including punctuation.
The shared confirmation host recognizes both English and Chinese question marks.
Imperative actions use `translateCurrent()` at dispatch time; rendered labels use
`useTranslation()` so language changes update them without losing local state.
Thread details include localized editor, script and Git actions, changed-file counts, and active
subagent statuses. Source-control settings and scope selectors also update with the language.
Subagent titles, progress, provider instance names and model names remain unchanged.
Settings descriptions, schema-driven provider fields, advanced controls, diagnostics labels,
theme tools, placeholders and accessible names use the same resources. Built-in schema metadata
is localized at the rendering boundary; stored values and option IDs are never translated.
External provider errors, raw diagnostic output and provider-supplied model descriptions remain
unchanged. New interface strings need entries in both resources.
Composite titles and select-value render functions must translate their own labels; the settings
row only translates plain string props. Translate interface-owned interpolation arguments before
inserting them, but preserve user/provider values. Keep sentence keys free of trailing spaces and
add spacing outside the translation call when composing descriptions.

Run the unit and real Chromium integration tests with the web package test command. The browser
coverage exercises actual settings/navigation/project components and the Markdown renderer,
including preservation of raw content and unsent input during language changes.
