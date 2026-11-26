# Projects with several repositories

A Cox project can span multiple Git repositories so one thread can read and edit all of them. The project folder can be a plain folder containing repositories such as `shop/api` and `shop/web`, a repository with siblings elsewhere, or a repository with Git submodules.

## Discovery and configuration

Cox discovers repositories one level below the project folder and one level deeper inside folders that are not repositories, such as `src/` or `packages/`. Cox picks up cloned and deleted repositories automatically and skips worktrees of other repositories. See the covered repositories in **Settings → Projects → Repositories**.

- **Add external folders** with **Add folder** in **Repositories** or run `cox project add <path> --track <folder>`. External folders listed in the project's `.code-workspace` file also appear with an **Add** button. Each machine can track up to 128 folders per project. Removing one leaves its files on disk.
- **Ignore repositories** by adding relative paths to `t3.json` in the project folder. Ignored repositories are omitted from individual reviews and worktree creation.

```json
{
  "ignoreRepositories": ["vendor/big"]
}
```

- **Submodules** initialize when Cox creates the parent worktree. If initialization fails, run `git submodule update --init` in the thread folder. A modified submodule appears separately for diffs and Git actions, and the parent repository shows its updated pin.

## Review, commit, and open pull requests

- **Turn diffs** group changed files by repository. The Diff pane's **Uncommitted**, **Changes**, and **Commits** sources read one repository at a time. The repository picker also lists repositories that only contain edits you made by hand.
- **Git actions** run one repository at a time. Expand a repository in the thread details panel to commit, push, or open a pull request. Use **Other repositories...** to include an untouched repository. Cox links the pull request under the repository that opened it.

## Worktree threads

**New worktree** creates a thread folder matching the project layout, with each selected repository on the thread's branch.

- Choose repositories next to the workspace picker before sending. Projects with up to eight repositories select all by default. With more than eight, choose the repositories yourself. Repositories with no commits are excluded. Your browser remembers your last choice.
- Add repositories to a running thread from **Other repositories...** in the thread details panel.
- Each repository starts from the thread's base branch if it has a branch of that name, or from its own default branch otherwise. For a plain project folder, enter the base branch at the bottom of the repositories control.
- Files outside repositories in a plain project folder link to their originals. Edits are shared across threads.

### Custom worktree layout

If the default layout does not suit your project, for example because build output must be per
thread, workspace metadata has to be generated, or submodules need preparing, the project can
create the folder with its own command. Add this to the `t3.json` in the project folder:

```json
{
  "worktreeLayout": {
    "create": "./scripts/new-workspace.sh",
    "remove": "./scripts/remove-workspace.sh"
  }
}
```

`create` runs in the project folder and must leave the thread's copy at `COX_WORKTREE_PROJECT_PATH`. Cox runs one layout command at a time per project and allows ten minutes per command.

| Variable                    | Value                                                      |
| --------------------------- | ---------------------------------------------------------- |
| `COX_PROJECT_ROOT`          | The project folder.                                        |
| `COX_WORKTREE_ROOT`         | The empty folder to fill for this thread.                  |
| `COX_WORKTREE_PROJECT_PATH` | Where the project folder goes inside it.                   |
| `COX_WORKTREE_BRANCH`       | The thread's branch name.                                  |
| `COX_WORKTREE_BASE`         | The base branch, or empty when the thread has none.        |
| `COX_WORKTREE_REPOSITORIES` | The repositories chosen for the thread, one path per line. |

Every repository of the project that the command checks out at the same relative place becomes the
thread's checkout of it. `remove` is optional and runs before Cox removes whatever is left.

What the commands can rely on, and what they must do:

- **Checkouts are linked worktrees on the thread's branch.** Make each one with
  `git worktree add` from the repository it belongs to, on `COX_WORKTREE_BRANCH`. Cox later
  removes, restores, and renames these through Git, so it refuses a clone or a checkout on another
  branch and the thread does not start.
- **`create` can run more than once.** It runs again when a thread's folder has gone missing, by
  which time the branch already exists. Check the branch out when it is there and create it
  otherwise.
- **`remove` can run on a folder that is partly gone**, such as after a failed `create` or an
  earlier cleanup. Storage cleanup never deletes files that exist only in the thread's folder, so
  `remove` should delete what `create` generated.
- **A failed `create` is rolled back.** Checkouts it already made are removed.
- **The commands run only for requests that may run commands on the host.** A client with neither
  `orchestration:operate` nor `terminal:operate` cannot create a task folder for a project that
  declares a layout. It can remove an existing task folder without running the project’s `remove` command.

#### Approve the commands

Cox runs `create` and `remove` only after you have approved them. The first time you start a
worktree thread in the project from the web or desktop app, it shows both commands in full and asks.
**Approve and continue** records the approval and starts the thread; **Cancel** leaves your draft as
it was. You can also review, approve, and revoke each command under **Worktree layout** in the
project's settings. Approving needs a client that can use the terminal (`terminal:operate`).

An approval is kept on the environment, not in the repository, and covers the exact text of one
command for one project. When the text in `t3.json` changes, for example after a pull, the command
stops running until you approve the new text. An approval covers the command text only: when the
command runs a script file, later changes to that file do not ask again.

While a command is not approved:

- **Nothing that needs `create` gets a worktree.** A worktree thread started by a scheduled task or an agent fails with a message that says so. Approve the command in the
  web or desktop app, then start it again.
- **A thread folder that went missing comes back as plain checkouts**, without the project's
  `create`.
- **Removing a thread's worktree skips `remove`** and removes the checkouts.

Agents never approve a command, and an approval is not enough for one that works below Full access.
When an agent hands its thread off to a worktree or starts a worktree thread, the commands run
only if the thread that asked is in Full access when they are about to run. A project that declares a
layout cannot create a worktree for an agent below Full access. In any project, an action set to **Run automatically on worktree
creation** does not run for a worktree an agent asked for below Full access. Start the worktree
thread yourself, or switch the thread to Full access.

A project with no other repository can declare a layout too. This example gives each thread
a worktree with its submodules checked out. The command runs in `sh`, and in `cmd.exe` on Windows,
so write it for the shell of the machine the project is on; this one is for `sh`:

```json
{
  "worktreeLayout": {
    "create": "(git worktree add \"$COX_WORKTREE_PROJECT_PATH\" \"$COX_WORKTREE_BRANCH\" 2>/dev/null || git worktree add -b \"$COX_WORKTREE_BRANCH\" \"$COX_WORKTREE_PROJECT_PATH\" ${COX_WORKTREE_BASE:-HEAD}) && git -C \"$COX_WORKTREE_PROJECT_PATH\" submodule update --init"
  }
}
```

## Rewind

Rewinding a thread restores its project folder and each repository it works in. Two cases are not
restored:

- **A plain project folder.** Only repositories have snapshots, so files that sit outside every
  repository keep their current contents.
- **A repository with no earlier snapshot.** If nothing was recorded for a repository before the
  turns you discard, it keeps their changes. The rewind still completes and names the repositories
  it left, so check their uncommitted changes afterwards.

## Limits

- One Git action runs in one repository. There is no commit or push across several at once.
- Only the project folder's `t3.json` is read. Setup scripts and actions inside one of its
  repositories are not picked up.
- The Diff pane's repository picker and the base branch field for a plain folder are on web and
  desktop only.
