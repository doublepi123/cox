# T3 Code selective ports, 2026-11-16

Reviewed upstream `pingdotgg/t3code` through `4860a73069` against Cox `54bfb4a`.
These are selective adaptations, not a merge of upstream main. The upstream MIT
license and attribution remain in place.

## Included

- [5dd8cde083](https://github.com/pingdotgg/t3code/commit/5dd8cde0831113058f2af74a699499c0eeb3b31b):
  keep idle ACP child-session output out of root history while preserving replay
  from the session currently being loaded or resumed.
- [6f5838f9bc](https://github.com/pingdotgg/t3code/commit/6f5838f9bcdaf31864b93694c5935c93f9532e06):
  treat a bare relative Add Project base directory as relative to home, and share
  the normalization between the command palette and client runtime. Preserve
  absolute, home-relative, explicit relative and Windows paths.
- [760f9cbe64](https://github.com/pingdotgg/t3code/commit/760f9cbe64e3409a7ebcc1ec16debe31a61e9f2b):
  explicitly prioritize custom thread-title instructions over generic length and
  format rules, both for initial and regenerated titles. Keep Cox branding and
  existing linked-context behavior.
- [e00614e126](https://github.com/pingdotgg/t3code/commit/e00614e126c5455c962395eaa743ff5c56d2b2ba),
  asynchronous setup portion: observe setup completion immediately and record its
  end timestamp. Cox already has a tested 15-second branch-name timeout; retain it
  rather than replacing it with upstream's 20-second timeout.

## Deliberately not merged wholesale

- T3 Connect, SSH-managed environments and multi-machine changes conflict with
  Cox's local-server and pure-remote-client boundaries.
- Upstream native mobile UI fixes do not map directly to Cox's Capacitor launcher.
- Upstream file-editor fixes modify a specific patched dependency version and
  need a separate dependency compatibility review.
- Database migration and Claude recovery changes target newer upstream lifecycle
  code. Do not transplant them without adapting and testing Cox's own migration
  and provider recovery paths.

Focused regressions accompany the ports. Full repository CI must pass on the
resulting commit before release; mocked providers are not live-provider validation.
