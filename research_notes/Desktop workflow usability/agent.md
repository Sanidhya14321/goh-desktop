# Coding agent usability

## How do existing apps get someone from installation to a useful first task?

### Takeaway
A short flow makes account setup, the selected project, and the first prompt visible. Explain what an approval does at the moment a concrete action needs a decision.

### Cited Findings
- The ChatGPT desktop app’s quickstart takes users through sign-in, choosing a project or folder, then composing a first message. Its Codex instructions suggest describing the result and adding relevant context. [ChatGPT desktop app quickstart](https://learn.chatgpt.com/docs/app)
- VS Code’s Agents quickstart selects the local environment, a workspace, an agent, a model, and Manual permissions, then supplies a concrete prompt and asks the user to follow approvals. [VS Code Agents quickstart](https://code.visualstudio.com/docs/agents/quickstart)
- Cursor offers a first prompt in the Agent panel and distinguishes an exploration-only Ask mode from editing modes. [Cursor Agent mode](https://cursor.com/help/ai-features/agent)
- GoHarness already supports reusable provider settings and open session tabs. New Session currently returns after opening the folder picker or provider settings, so an intended session can require the user to repeat their request. [GoHarness workspace actions](../../frontend/src/main.ts)

### Inferences
- P0. Carry New Session intent through a successful native folder pick and, if needed, provider setup. Closing either chooser should cancel the continuation. Preserve the original selected project during any async provider flow. Promote a concise first-send prompt starter into the blank chat view and insert its editable text without sending automatically.
- Label a starter such as “Explain this project” by its outcome and ask for an explanation without edits. Reserve a Read-only label for a genuinely enforced mode. Avoid asking for provider credentials before opening a local terminal.
- Test cancel picker, follow-through with an existing provider, provider save and cancel, and preservation of an unsent prompt while fixing setup.

### Gaps
- No competitor source establishes that sample prompts improve engagement or provides a comparative time-to-first-task measurement. This recommendation is a design inference. Whether existing GoHarness providers are usable can only be learned by successful authentication, validation, or first request, depending on provider.

## How can users see and route requests needing attention across projects?

### Takeaway
Give attention one discoverable entry point across projects. Keep the actual decision on the owning session and expose the relevant action, destination, and approval scope.

### Cited Findings
- VS Code’s Agents window groups sessions across workspaces and lets users select a session to answer its question or review an approval. Its experimental Inbox can surface questions, approvals, errors, and results to review. Opening or reading an Inbox item does not acknowledge it. [VS Code Agents window](https://code.visualstudio.com/docs/agents/run/agents-window) and [Organize and triage agent sessions](https://code.visualstudio.com/docs/agents/run/sessions/organize-sessions)
- Copilot’s tool prompts ask users to inspect tool inputs and the affected command, path, or destination, then allow the current call or decline. Persistent permissions are a separate capability with broader scope. [Manage approvals and permissions](https://code.visualstudio.com/docs/agents/run/approvals)
- Codex documents technical sandbox scope independently from when an agent must ask for approval. VS Code separately restricts code execution in untrusted projects and calls out the possibility of shell initialization automatically executing code. [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security) and [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust)
- GoHarness already tracks pending requests on each live tab and highlights relevant tabs. The request body is rendered only in the active session, and the provider-neutral host verifies that its challenge still belongs to the given session before sending an answer. [GoHarness session UI](../../frontend/src/main.ts) and [GoHarness host](../../internal/desktop/host.go)

### Inferences
- P0. Add a workspace-level Needs input count and compact list, using real per-session pending challenge state. Each row names the project and session and identifies a question or approval. Activation opens the owning session and focuses the challenge heading. Viewing another session or closing the list should leave the challenge pending. Successful reply, cancellation, or run completion should update the count.
- Keep actual approval buttons against existing session and challenge IDs. Present project path and the exact engine-supplied tool preview before offering the existing allow-once and deny actions. Highlighting a proposed change does not authorize it. Preserve the current backend approval scope.
- Regression tests should hold a question or an approval in an inactive project, navigate from the global affordance, validate correct target and count updates, and confirm the draft in the original project survives.

### Gaps
- VS Code Inbox is experimental. Use the customer workflow principle of cross-project triage rather than relying on stable behavior for Inbox grouping or snooze.
- GoHarness project trust would require separate end-to-end lifecycle and shell-path enforcement, including how a previously opened project becomes trusted. No trust boundary is established by adding a badge or copying competitor terminology.

## What do useful review and recovery surfaces expose?

### Takeaway
A good review surface separates what a tool proposes, what the working tree contains, and what a recovery action can actually change. Failure state should remain attached to its session.

### Cited Findings
- VS Code distinguishes pending tracked edits from diffs for other harnesses. Its Changes view opens a file diff, supports a narrower single-file presentation, tracks reviewed files, and points to source control for untracked or out-of-band changes. Its checkpoint documentation limits rollback to affected files and chat history. [Review and revert agent changes](https://code.visualstudio.com/docs/agents/run/review-code-edits)
- Codex’s desktop local review pane requires a Git repository and exposes the diff for inspection and feedback, independently of the built-in read-only review command. [OpenAI Code review](https://learn.chatgpt.com/docs/code-review#review-local-changes)
- VS Code’s recovery guide asks users to inspect whether a task is waiting for input, running a terminal command, or blocked by an error before choosing whether to stop, revise, or revert. Stopping a request leaves completed actions in place. [Get an agent back on track](https://code.visualstudio.com/docs/agents/guides/get-agent-back-on-track)
- Current GoHarness renders a tool preview on the owning tab before an approval and exposes an acknowledgement/ retry path when the engine reports uncertain effects. Its first-send path can clear a composer on accepted start before a subsequent run-level error arrives. [GoHarness session UI](../../frontend/src/main.ts)

### Inferences
- P0. Preserve failed session context and make the error scannable in place. Offer “Recover prompt” or “Edit last message” to restore the text into an editable draft without dispatching another run or overwriting a newer draft. Keep uncertain-effect acknowledgement explicit and separate. Distinguish stopped, declined, and failed from completed.
- P1. Consider a read-only project Changes view using the actual Git working tree, with a clearly scoped selected file and user-initiated refresh. Label it “Working tree changes” because local/manual changes may be present too. Keep proposed edit previews visually distinguishable in approvals. A Git-only view needs a clear non-Git state and should not run diff drivers, hooks, filters, or commands derived from page text.
- Defer rollback buttons, auto-approval patterns, or session-owned diff claims until their backend can positively identify and safely reverse the correct effects. A completion message alone does not prove an agent’s validation succeeded.

### Gaps
- There is no evidence that GoHarness currently records enough information to produce a complete session-specific diff covering user edits, shells, subagents, and existing dirty files. Do not describe a working-tree diff as changes made by an individual agent.
- Error details depend on the active provider and GoHarness engine. Retrying after an unknown failure could duplicate side effects. This is why restoring a prompt for user review is a lower-risk starting point than automatic resend.
