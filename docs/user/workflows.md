# Workflows

A workflow is a TypeScript script that chains agents, plain code, schedules, webhooks, pull request events, and questions to you into one durable run that survives server restarts. Each step's result is saved when it succeeds, so restarts pick up where the run left off and failures do not lose earlier work. Workflows are an early feature: start runs from the `cox` CLI or a trigger, and follow them in the app.

For one prompt on a timer or webhook, use a scheduled task. Use a workflow when work has stages — such as triage, a fix, your approval, and a release.

## Turn on workflows

Workflows are a Labs feature, off by default. Turn on **Settings → Labs → Workflows** for the server that runs them. On a server without a desktop, set `"workflowsEnabled": true` in `userdata/settings.json` in its Cox home (`~/.cox` by default). While off, nothing in the workflows folder runs and `cox workflow` says how to turn it on; runs are kept and continue once it is on again.

## Create a workflow

Workflow files live in `~/.cox/workflows/` (or wherever `COX_WORKFLOWS` points — a folder or a single file). The server watches the folder and reloads changes without a restart.

- **Ask an agent (recommended):** copy the [`cox-workflows` skill](https://github.com/pingdotgg/t3code/blob/main/skills/cox-workflows/SKILL.md) into your agent's skills folder (such as `~/.claude/skills/` or `~/.agents/skills/`) and describe what you want.
- **Edit directly:** edit files in `~/.cox/workflows/`, or use **Definitions** on the Workflows page (saving and deleting in the app require terminal access). Before anything has run, open the page with **Open workflows** in the command palette.

A small workflow, saved as `~/.cox/workflows/release.ts`:

```ts
const { workflow, step, ask, stop, title } = Cox;

export default workflow(
  "release",
  { version: 1, payload: Schema.Struct({ name: Schema.String }) },
  Effect.fn(function* (payload) {
    yield* title(`Release ${payload.name}`);
    const notes = yield* step("notes", { returns: Schema.String }, Effect.succeed("3 fixes"));
    const answer = yield* ask("ship", {
      title: `Ship ${payload.name}? ${notes}`,
      choices: ["Ship", "Hold"],
    });
    if (Option.isNone(answer) || answer.value.choice !== "Ship") return yield* stop("held back");
    return { shipped: payload.name };
  }),
);
```

Start it with `cox workflow start release --input '{"name":"v1.4"}' --key v1.4`, then answer its question in the app. `Cox`, `Effect`, `Schema` and `Option` are provided; a workflow file imports nothing from Cox or Effect. Name files with letters, digits, `-`, `_` and `.`; other names are skipped with a warning.

Saving checks that the file loads, does not duplicate a workflow name and version, and does not remove a version with unfinished runs. A file that fails these checks keeps its last working version while the Workflows page (and the server log) shows why; other files are not affected. A change held back by unfinished runs goes in by itself once those runs end or are cancelled. Mistakes inside a workflow body surface when a run hits them and pauses. To change steps while runs are unfinished, add the new body under a higher `version` and keep the old one until those runs end.

Dot-files and subfolders are ignored. Keep shared helpers in a subfolder and restart the server after editing an imported file.

## Start and steer

```sh
cox workflow start <name> --input '<json>' --key <key>
cox workflow list [--status paused]
cox workflow show <run>
cox workflow resume <run>
cox workflow cancel <run> [--reason '<why>']
cox workflow questions
cox workflow signal '{"choice":"yes"}' --run <run> --wait <name>
cox workflow signal '<json>' --workflow <name> --channel <channel>
cox workflow hooks
cox workflow store list
cox workflow store set <key> '<json>'
```

Every start needs a `--key`: starting twice with the same key returns the same run — even after a version bump — so retries do not duplicate work. Use `signal` with `--run` and `--wait` to answer a question or wake a run, or with `--workflow` and `--channel` to wake whichever run waits on that channel. A signal for a question that is no longer open is kept for a later wait rather than refused, so check `cox workflow questions` first. Use `store` to read or change state kept between runs.

For the `cox_workflow` MCP tool, full access in default interaction mode is required to start, signal, resume or cancel runs, change stored state, or read webhook paths. Lower modes can still read runs, questions and stored state.

## Triggers

- **Schedules:** `every` runs on an interval, starting one interval after the workflow loads; `daily` runs at a local time of day (a time missed by more than 10 minutes while the server is down is skipped).
- **Webhooks:** `cox workflow hooks` prints each hook's path; prepend your server's address. The path contains the hook's secret, so share it only with the sender. A sender's retry that repeats its delivery header (such as GitHub's `X-GitHub-Delivery`) starts no second run, and bodies over 1 MiB are refused.
- **Pull requests:** workflows can start when a pull request opens and read, comment on, or update it using the project’s Git host credentials. Cox checks roughly once a minute and starts runs for pull requests opened after the workflow first loaded.

## Follow runs in the app

Open the Workflows page with **Open workflows** in the command palette of the web or desktop app; the entry shows once a connected server has workflows on. Filter by **Needs you**, **Running**, or **All** (skipped runs stay hidden unless toggled on), open child runs from their parent, and answer questions, resume paused runs, or cancel active runs (requires permission to operate threads). The pull requests a run touched show as chips under its title and on the steps that touched them; a chip opens the item beside the run, in a tab next to any agent transcripts you opened.

### Agent threads

Each `agent` step runs in an ordinary thread, left out of thread lists (including `cox thread list`). Open it from the run to watch it live, read its transcript, or send follow-up messages; the thread links back to the run.

### Failures, pause, and cancel

A plain code step runs once unless it asks for retries. When a step fails, the run pauses there instead of losing earlier work:

- **Code step failures** retry automatically after 5, 20, and 80 minutes by default, or immediately when you resume; only that step runs again.
- **Agent failures** — when an agent ran and gave up or timed out — pause and wait for you to resume rather than retrying automatically. An agent that could not be started at all, for example because its environment was offline, retries on its own like a failed step.

Cancelling a run stops its active agent turns and cancels child runs it invoked. A cancelled run cannot be resumed.

## Limits

- Runs live on the server that started them and only advance while it is running; use an always-on machine for schedules or webhooks you cannot miss.
- Keep older workflow versions defined until their unfinished runs end or are cancelled.
- Signals sent to a `channel` before a run waits on it are kept for 7 days by default.
