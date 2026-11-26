# Workflows

Workflows are durable TypeScript scripts that chain agents, code steps, schedules, webhooks, pull request events, and questions. Cox saves successful step results, so a run can resume after a server restart.

Use a scheduled task for a single prompt on a timer or webhook. Use a workflow for work with several stages, such as triage, a fix, your approval, and a release.

## Enable workflows

Turn on **Settings → Labs → Workflows** on the server that will run them. On a headless server, set `"workflowsEnabled": true` in `~/.cox/userdata/settings.json` or the equivalent path in your Cox home. Disabling workflows pauses existing runs until you enable them again.

## Create a workflow

Workflow files live in `~/.cox/workflows/` (or wherever `COX_WORKFLOWS` points — a folder or a single file). The server watches the folder and reloads changes without a restart.

- **Ask an agent (recommended):** copy the [`cox-workflows` skill](https://github.com/doublepi123/cox/blob/main/skills/cox-workflows/SKILL.md) into your agent's skills folder (such as `~/.claude/skills/` or `~/.agents/skills/`) and describe what you want.
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

## CLI commands

```sh
cox workflow start <name> --input '<json>' --key <key>
cox workflow list [--status paused] [--tag <tag>]
cox workflow show <run>
cox workflow resume <run>
cox workflow cancel <run> [--reason '<why>']
cox workflow questions [--kind <kind>]
cox workflow signal '{"choice":"yes"}' --run <run> --wait <name>
cox workflow signal '<json>' --workflow <name> --channel <channel>
cox workflow hooks
cox workflow store list
cox workflow store set <key> '<json>'
```

Every start needs a `--key`: starting twice with the same key returns the same run — even after a version bump — so retries do not duplicate work. Use `signal` with `--run` and `--wait` to answer a question or wake a run, or with `--workflow` and `--channel` to wake whichever run waits on that channel. A signal for a question that is no longer open is kept for a later wait rather than refused, so check `cox workflow questions` first. Use `store` to read or change state kept between runs.

For the `cox_workflow` MCP tool, full access in default interaction mode is required to start, signal, resume or cancel runs, change stored state, or read webhook paths. Lower modes can still read runs, questions and stored state.

## Kinds of question and tags

A workflow that asks more than one kind of question can name the kinds, so you can answer one kind at a time. List them in the workflow's options with the label to show, and give each `ask` its `kind`:

```ts
const { workflow, ask, tags, Issue } = T3;

workflow(
  "triage",
  {
    version: 1,
    payload: Issue,
    asks: { feature: "Feature wanted?", intended: "Bug or intended?" },
  },
  Effect.fn(function* (issue) {
    yield* tags(["backlog"]);
    yield* ask("wanted", {
      kind: "feature",
      title: `Build ${issue.title}?`,
      choices: ["Yes", "No"],
    });
  }),
);
```

Under **Needs you**, a picker then shows each kind with how many questions of it are open, and **Other** for the rest; your pick is remembered on that device. A question whose kind is not in the workflow's own `asks` is asked like any other and shows under **Other**, as do questions asked without a kind. `cox workflow questions --kind feature` lists the questions asked with exactly that kind from the CLI.

`tags([...])` labels a run for `cox workflow list --tag backlog`, whether or not it waits on anyone.

## Triggers

- **Schedules:** `every` runs on an interval, starting one interval after the workflow loads; `daily` runs at a local time of day (a time missed by more than 10 minutes while the server is down is skipped).
- **Webhooks:** `cox workflow hooks` prints each hook's path; prepend your server's address. The path contains the hook's secret, so share it only with the sender. A sender's retry that repeats its delivery header (such as GitHub's `X-GitHub-Delivery`) starts no second run. Bodies over 1 MiB are refused, and each hook can start up to 60 new runs per minute. Further deliveries receive HTTP 429 with `Retry-After: 60`.
- **Pull requests:** workflows can start when a pull request opens and read, comment on, or update it using the project’s Git host credentials. Cox checks roughly once a minute and starts runs for pull requests opened after the workflow first loaded.

## Follow runs, agent threads, and failures

Open the Workflows page with **Open workflows** in the command palette of the web or desktop app; the entry shows once a connected server has workflows on. Filter by **Needs you**, **Running**, or **All** (skipped runs stay hidden unless toggled on), open child runs from their parent, and answer questions, resume paused runs, or cancel active runs (requires permission to operate threads). The pull requests a run touched show as chips under its title and on the steps that touched them; a chip opens the item beside the run, in a tab next to any agent transcripts you opened.

Top-level skipped runs, such as webhook deliveries a workflow chose to ignore, do not keep the payload they started with. Each workflow keeps its latest 500 of them and deletes older ones about an hour after they end; change the number in **Settings → Labs → Skipped runs kept** (0 keeps none), or set `"workflowSkippedRunsKept"` in `userdata/settings.json`. Runs that did anything else are never deleted. Once a skipped run is deleted, a start with its key or a webhook retry with its delivery header starts a new run.

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
