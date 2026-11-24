# GoHarness Desktop feature research

## Implementation scope

This pass adds per-turn Plan and Build, engine-reported verification with recent run history, and native export for Markdown transcripts and portable session archives. Project file references are a follow-up that needs picker and quoting tests across macOS, Ubuntu, and Windows.

## Question 1 — How should users move from planning to changes?

### Takeaway

Put Plan and Build next to Send. Use the engine’s selected agent for each turn and make the next Build turn a deliberate choice in the same conversation.

### Cited Findings

- VS Code lets users review the approach, affected code, and planned checks, submit feedback, and decide when to start implementation. Cursor exposes a mode picker and a separate action to build after plan review. [VS Code planning](https://code.visualstudio.com/docs/agents/run/planning), [Cursor Plan Mode](https://prod.cursor.com/docs/agent/plan-mode)
- GoHarness Plan exposes reads, skills, and questions. The engine refuses edits, shell commands, and MCP in that mode, regardless of grants. In v1.1.0, `goh serve --agent` selects the agent at helper startup and the helper reports it in `/v1/info`. The run request takes a prompt and an optional acknowledgement of uncertain effects. [GoHarness user guide](../../../goh/docs/USER_GUIDE.md#agents-profiles-and-model-roles), [serve command](../../../goh/cmd/harness/serve.go), [local API](../../../goh/internal/localapi/server.go)

### Inferences

Make the selected mode visible before submission. On an idle mode switch, start a helper configured for the selected agent and reopen the same session journal. Show the mode used for a turn in evidence only where the engine provides it or Desktop recorded it on submission. Keep approval and question routing separate from mode selection. Clarify that Plan can ask questions and Build can request approvals.

### Gaps

Verify the bundled engine’s resolved agent and profile behavior on both new and resumed sessions, especially in projects with custom defaults.

## Question 2 — What should run and agent activity tell users?

### Takeaway

Place a compact engine-reported outcome beside the completed turn and let users expand the supporting check. Keep child-agent status visible in the session’s activity pane when it contributes to the run.

### Cited Findings

- VS Code asks users to inspect tests, builds, and failures before accepting agent changes. Its diagnostics provide a deeper view of tool and timing evidence. [VS Code Agents window](https://code.visualstudio.com/docs/agents/run/agents-window#validate-changes), [VS Code chat debugging](https://code.visualstudio.com/docs/agents/agent-troubleshooting/chat-debug-view)
- GoHarness emits `verification_started` and `verification`, and reports `verified`, `unverified`, `no_changes`, or `failed_verification` in `run_finished`. When present, `verification_detail` provides change tracking and the check’s source, command, kind, scope, pass state, exit code, and revision. A successful verification must qualify under engine rules and run after the last observed change. [GoHarness user guide](../../../goh/docs/USER_GUIDE.md#headless-cli), [runtime verification](../../../goh/internal/runtime/verify.go)

### Inferences

Keep the lifecycle status and verification outcome distinct. Label `unverified` as “Changes unverified,” and report failed checks even if the lifecycle finished. Display commands and results verbatim where available, with limits on retained output. Attribute child activity to the correct run and agent identifiers. Restore recent evidence from the authoritative session data if available, and tolerate absent fields in older journals and engines.

### Gaps

Check what the present API can replay without starting a helper, and test evidence after closing the app, across two active projects, and after interruption.

## Question 3 — What makes session export safe and useful?

### Takeaway

Offer a session-scoped native Save dialog with a shareable transcript and a separately labelled portable archive. Give tool output its own opt-in when the selected format supports it.

### Cited Findings

- VS Code allows exports to a chosen path as JSON, copies chat messages as Markdown, and asks users to review sensitive prompts, responses, attachments, and tool output before sharing. [VS Code session history](https://code.visualstudio.com/docs/agents/run/sessions/session-history)
- GoHarness supports Markdown and HTML transcripts with optional `--include-tools`, and a JSON export for engine import. The engine documents that exports are unredacted, omit checkpoint blobs, preserve existing files, and do not carry permission grants into a new session. [GoHarness user guide](../../../goh/docs/USER_GUIDE.md#sessions-and-recovery), [GoHarness session command](../../../goh/cmd/harness/sessions.go)

### Inferences

Default to Markdown with tool output omitted. Label JSON “Portable session archive,” mention its broader contents near the format option, and keep the workflow local. Keep path and session resolution in Go. Match the engine’s file-collision rules and report an existing filename clearly. Test that exports do not alter the live session.

### Gaps

Both export formats acquire the journal’s writer lock. Test the active-session message and the retry after runs end. Check whether imported sessions can be resumed from Desktop in a future iteration. Engine imports of interrupted archives require the source session’s uncertain effects and transcript to have been resolved before export. [GoHarness portable archive](../../../goh/internal/session/portable.go)

## Question 4 — How should explicit file context work?

### Takeaway

Offer a keyboard-operable picker scoped to the active project. Keep chosen paths visible in the composer and confirm attachment only when the engine emits `files_attached`.

### Cited Findings

- Zed exposes a typed `@` picker for explicit context. VS Code offers both a typed picker and an Add Context control, making explicit context discoverable without remembering a shortcut. [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel#adding-context), [VS Code chat context](https://code.visualstudio.com/docs/chat/copilot-chat-context#add-files-as-context)
- GoHarness uses `@path` and Go string quoting for paths containing spaces or quotes. It attaches regular project-relative UTF-8 files within its limits, honors deny rules and root confinement, and emits the successfully attached paths. Paths that do not qualify remain plain mentions. [GoHarness file mentions](../../../goh/internal/runtime/file_mentions.go), [GoHarness runtime](../../../goh/internal/runtime/runtime.go)

### Inferences

Let the picker insert references without reading file contents in the webview. Preserve project-relative names, use the engine’s quoting rules, and describe selected items as references until attachment is confirmed. Keep separate drafts for separate projects. A selected path should confer no additional permissions.

### Gaps

Validate paths with spaces, quotes, and Unicode on all three operating systems. Check project switches and denied, oversized, or binary files before marking references as successfully attached.
