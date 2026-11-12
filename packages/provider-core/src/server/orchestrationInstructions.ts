import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## Cox orchestration

Ordinary coding tasks need no Cox tools. Cox controls this local machine only; remote machine linking, cloud relays and native app devices are not available.

- Subagents: prefer your own available native subagent tools for delegation, reviews and parallel work. Generic requests to "use subagents" or "work in parallel" do not ask for another Cox agent or provider. Keep native roles, model settings, workspace isolation and background execution when supported; a different child model or native background task alone does not require Cox delegation. Use \`delegate_task\` only for an explicitly requested Cox agent/provider or Cox delegation, when no native subagent capability exists (for example Pi without a subagent extension), or for a required capability native tasks cannot support. Never invent a native tool. Workflow only when asked.
- Native subagent failure, exclusion or denial: report the original error; never silently switch to Cox delegation, another provider or another tool. Keep an explicitly requested Cox target and report its failure too. Cox's display of native tasks does not launch or re-run them.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`cox_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`cox_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`cox_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`cox_thread_read\` it before you answer about it.
- Moving a conversation to another project: \`cox_thread_move\` preserves its ID and history and changes the workspace. Do not use launch, fork, or context transfer. When moving yourself, call it last; the agent restarts in the target workspace. Pass \`continuationPrompt\` for work to resume, and reuse \`clientRequestId\` if retrying.
- In your reply, mention a thread by its \`link\`, verbatim. Never a plain title or bare id.
- A secret, including a sudo password: call \`request_secret\` yourself. Pass its \`secretRef\` to a Cox tool, or use \`delivery: "file"\` for a shell command. If \`sudo -n <cmd>\` requires a password, run \`sudo -S -p '' <cmd> < "$file"\`; give other input as a file argument because the password takes stdin. Never ask in chat or invent one. When asked only to schedule, \`schedule_task\` without running its prompt.
- Cox tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass the path to an HTML file, or inline HTML to \`html_preview\`, then \`html_render\`. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Do not repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const OMO_NATIVE_SUBAGENT_INSTRUCTIONS = `- OMO subagents: when the user asks to use subagents, delegate work, or work in parallel without naming a Cox agent/provider, prefer OMO's native \`task\` and its configured roles such as \`atlas\`, \`explore\`, and \`oracle\`. Keep their native role/model configuration and execution, including native background work; Cox observes those tasks without launching another agent. Do not select another Cox agent merely because its model differs from the main model.
- Use Cox \`delegate_task\` only when the user explicitly requests a Cox agent, another provider, or Cox delegation by name, or the work requires a capability OMO native tasks do not support. Query Cox capabilities only for that explicit or unsupported-capability case. A generic request to parallelize is not a request for cross-provider delegation. Keep an explicitly requested Cox target; never replace it silently.
- If native \`task\` fails, is unavailable, is excluded, or is denied, report its original error and stop that delegation attempt. Never silently retry it as a Cox delegate or change provider. A native task already observed by Cox must not be launched again for display. Workflow only when asked.`;

export const OMO_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) =>
  index === 0 ? section.replace(/^- Subagents:.*$/m, OMO_NATIVE_SUBAGENT_INSTRUCTIONS) : section,
).join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## Cox browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the Cox tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`"$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## Cox interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until Cox supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## Cox interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until Cox supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<cox_instructions>\n${instructions.join("\n\n")}\n</cox_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<cox_orchestration_instructions>${instructions.trim()}</cox_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly orchestrationDelivered: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependT3OrchestrationInstructions(input.prompt, T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  }
  return input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
