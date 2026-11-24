# Bring GoHarness capabilities into each session

GoHarness Desktop can make three capabilities of its bundled v1.1.0 engine easier to use. A mode selector beside Send lets the user explore a project in Plan and decide when to continue in Build. Recent run details show what the engine verified and which checks support the outcome. Session export saves a Markdown transcript or portable JSON archive through the native Save dialog. The design keeps all three actions attached to the selected session and uses the existing engine interfaces. [GoHarness v1.1.0 user guide](https://github.com/Sanidhya14321/goh/blob/v1.1.0/docs/USER_GUIDE.md)

## Put the Plan and Build decision beside Send

VS Code lets users review the approach, affected code, and proposed checks before choosing when to implement. Cursor puts a mode picker in the conversation and gives users a separate build action after review. GoHarness Desktop should offer **Configured agent**, **Plan**, and **Build** in the composer. Plan uses a restricted tool set for project exploration and can ask questions. Build uses the current permissions and can raise approvals in the usual session workflow. [VS Code planning](https://code.visualstudio.com/docs/agents/run/planning) · [Cursor Plan Mode](https://prod.cursor.com/docs/agent/plan-mode) · [GoHarness agents and profiles](https://github.com/Sanidhya14321/goh/blob/v1.1.0/docs/USER_GUIDE.md#agents-profiles-and-model-roles)

The engine selects its agent when `goh serve` starts and reports the resolved agent in `/v1/info`. Keep the default configuration path available, start or rotate an idle helper for an explicit mode, verify the resolved agent, and retain the session journal, per-checkout writer limit, and approval routing. In v1.1.0, the built-in Plan tool records a handoff on its runtime instance and **the TUI consumes that handoff**. Desktop uses the HTTP API, so explain how to select Build and submit the next turn in the same conversation after planning ends. [Serve flags](https://github.com/Sanidhya14321/goh/blob/v1.1.0/cmd/harness/serve.go#L19-L50) · [Helper info](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/localapi/server.go#L96-L112) · [Plan handoff](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/runtime/plan_exit.go#L12-L55) · [TUI handoff consumer](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/tui/queue.go#L80-L103) · [HTTP run exit](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/localapi/server.go#L347-L359)

## Let users inspect the engine’s verification evidence

VS Code encourages users to inspect builds, tests, and failures before accepting agent changes. GoHarness distinguishes **Verified**, **Changes unverified**, **No changes**, and **Verification failed**. A check qualifies under engine rules only if it runs after the last observed change. Use the engine’s outcome for the verification label and report run completion separately. Show recorded commands and the available source, kind, scope, pass state, exit code, and revision in the run history dialog. Restore a bounded set of recent outcomes from the session journal and leave verification unspecified when an older record omits it. [VS Code change validation](https://code.visualstudio.com/docs/agents/run/agents-window#validate-changes) · [GoHarness verification semantics](https://github.com/Sanidhya14321/goh/blob/v1.1.0/docs/USER_GUIDE.md#headless-cli) · [Engine run events](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/runtime/runtime.go#L1551-L1579)

## Save transcripts and portable archives locally

Default to **Markdown transcript** with tool records omitted. Offer an explicit tool-output option for Markdown and a **Portable session archive** option for engine-compatible JSON. Explain that exports are unredacted and can include private session content. Use the native Save dialog and run the bundled engine against the selected session’s journal. Both formats take the session writer lock. Present export as an idle-session action and keep the engine’s existing-file protection. The engine publishes the file using a hard link, so destinations on filesystems that lack hard-link support can fail. [VS Code session sharing](https://code.visualstudio.com/docs/agents/run/sessions/session-history) · [GoHarness sessions and recovery](https://github.com/Sanidhya14321/goh/blob/v1.1.0/docs/USER_GUIDE.md#sessions-and-recovery) · [Engine export command](https://github.com/Sanidhya14321/goh/blob/v1.1.0/cmd/harness/sessions.go#L158-L190) · [Atomic export file creation](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/session/export_file.go#L11-L43)

## Verify the features with the bundled engine

Use a scripted provider to exercise Plan followed by Build in one session and confirm the provider sees the mode’s actual tool set. Confirm approvals still resolve against the owning session when two projects are active. Check that a recorded verification result survives reopening, and exercise both exports, the active-session guard, and a filename collision. Record which builds and runtime flows were exercised for each operating system and architecture.

Project file references are a candidate for a subsequent pass. Zed and VS Code make explicit context discoverable, and GoHarness already supports project-relative `@` references. A desktop picker can insert a reference and use the engine’s attachment event to confirm success. Testing paths with spaces, quotes, and Unicode on all three platforms is part of that design. [Zed agent context](https://zed.dev/docs/ai/agent-panel#adding-context) · [VS Code chat context](https://code.visualstudio.com/docs/chat/copilot-chat-context#add-files-as-context) · [GoHarness reference parser](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/runtime/file_mentions.go#L24-L117) · [Engine attachment events](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/runtime/runtime.go#L670-L690)


## Packaged results

Tested on 24 November 2026 with Desktop `0.1.4` and GoHarness `v1.1.0`. The workspace fixture exercised fresh-profile onboarding, separate project terminals, concurrent file approval and question routing, Plan proposal review, Plan and Build in the same session, and a recognized verification command after a real edit. After relaunch, the session restored both its selected mode and its verification evidence. The fixture checked the export dialog defaults, called the same host export path with deterministic filenames, read both generated files, and confirmed that active-run export and an existing destination were rejected. The interactive OS Save dialog itself was outside the fixture. The agent smoke also passed, including cancellation and clean exit. The macOS update regression fixture preserved existing sessions as Desktop moved from `0.1.1` to `0.1.2` and its fixture engine moved from `1.1.0` to `1.1.1`. The tampered payload was rejected.

| Target | Local result |
| --- | --- |
| macOS arm64 | Installed from the universal development DMG and ran both fixtures via LaunchServices. Verified the ad hoc signatures and both architecture slices for the desktop app and nested engine. |
| macOS amd64 | Inspected the Intel slices. Native GUI runtime remains unverified here. |
| Ubuntu 24.04.4 arm64 | Installed the development DEB with APT and ran both fixtures from the desktop entry in Xvfb and a D-Bus session. |
| Ubuntu 24.04 amd64 | Cross-built the development DEB and ran its version probe under x86-64 emulation. |
| Windows amd64 and arm64 | Cross-built development NSIS installers and inspected the PE payloads. Native Windows runtime remains unverified here. |

The macOS host was a 15-core Apple M5 Pro MacBook Pro with 24 GiB RAM running macOS 27.2.1 (26B131). Ubuntu ran on the same host in a VZ VM with four vCPUs and 6 GiB assigned RAM. These are single samples. Desktop RSS sums the app, webview, and helpers, including shared pages. The desktop idle sample had zero engine helpers, and both active samples waited on scripted approvals. Standalone idle is one ready helper. Standalone cold start stops at an authenticated engine info response. The Ubuntu VM uses software rendering.

| Workload | Package or binary | Cold ready | Idle RSS | Two active RSS |
| --- | ---: | ---: | ---: | ---: |
| macOS arm64 Desktop | 23.42 MiB | 642 ms | 195.16 MiB | 245.56 MiB |
| macOS arm64 standalone | 13.83 MiB | 16.34 ms | 21.03 MiB | 46.57 MiB |
| Ubuntu arm64 Desktop | 8.11 MiB | 965 ms | 669.74 MiB | 765.95 MiB |
| Ubuntu arm64 standalone | 13.50 MiB | 10.51 ms | 16.59 MiB | 32.29 MiB |

Reproduce the runs with the package and smoke commands in the [README](../README.md). Go race tests, Go vet, the TypeScript build, and Actionlint passed locally.
