# GoHarness Desktop end-to-end audit

This pass compares the Desktop workflows with the bundled GoHarness v1.1.0 engine. It exercises the installed webview, Wails bindings, desktop host, actual GoHarness helper, and a loopback scripted provider. The fixtures use disposable projects and user directories. The upstream checkout and real provider accounts are outside the test. [GoHarness v1.1.0 user guide](https://github.com/Sanidhya14321/goh/blob/v1.1.0/docs/USER_GUIDE.md) · [Engine HTTP API](https://github.com/Sanidhya14321/goh/blob/v1.1.0/docs/USER_GUIDE.md#http-api)

## Coverage

| Workflow | Exercised behavior |
| --- | --- |
| Install and first launch | LaunchServices launches the application copied from the universal DMG. APT installs the actual Ubuntu package and the fixture launches its desktop entry. Both use the bundled engine with an isolated profile. |
| Provider setup | Create the requested session after first-run configuration. Reuse existing GoHarness settings, reject plain HTTP for a remote provider, switch to a loopback override, restore the existing config, and keep the override locked while a run is active. |
| Provider requests | The Chat Completions fixture checks an HTTP 401 and a successful follow-up in the same session. The Responses and Messages fixtures check streaming and their credential headers. The UI clears the API key field after saving. |
| Engine policy and attachments | A configured deny rule still prevents an attachment under a desktop provider override. Eligible UTF-8 files reach the provider, confirmed filenames appear in the correct turn, and names restore from the journal. A path outside the project is rejected. |
| Workspaces and concurrency | Two independent projects run together. Sibling folders in one Git checkout share a writer slot. A linked Git worktree can run alongside the checkout. A third active run is refused. A blocked message stays in its composer when switching tabs. |
| Review, questions, and cancellation | Allow or deny an actual edit, reject an approval ID from the wrong session, route questions to their owning tab, check multi-select and a custom answer, and reject an empty selection with an inline prompt. Plan uses its restricted tool set, and explicit Build reuses the same session. The agent smoke covers child events, cancellation, and quitting with an approval pending. |
| Recovery and reopening | A journal with an interrupted tool receives the engine’s HTTP 409. The draft remains editable until explicit acknowledgment, and the retry writes exactly one message. Moving the last selected project preserves other tabs and displays an unavailable-folder message when the app reopens. Workspace preferences, verification evidence, and file context restore on a normal restart. |
| Terminals and export | Real shells retain their project directories in the split dock. Search and focus stay within the selected terminal. Both export formats work on an idle session. Export during a run and overwrite attempts are rejected. |
| Helper lifecycle | Two active helpers appear in the process tree. The observer checks that the last idle helper exits while Desktop is still open. The packaged agent test checks that no helpers are left behind after quit. |
| Updates | The macOS signed-fixture path stages while active, blocks restart until idle, replaces the UI and engine together, and reopens an existing session. A modified payload is rejected. |

A separate interactive macOS test opened the native project chooser, selected a temporary folder, connected the local provider through the UI, added a file through the native attachment picker, sent a message, and saved a Markdown transcript through the native Save dialog. The saved file contained the user message and scripted response. The audit discovered and corrected the export checkbox spacing in the webview.

## Changes from the audit

- Provider overrides now use the engine’s documented environment settings. The engine still loads the user configuration, including file rules and other non-provider settings. The previous desktop-generated minimal config discarded them.
- A draft stays in the composer until the engine emits its start event. A rejected run adds no phantom conversation entry. Recovery lets the user review the reported tool IDs, edit the prompt, and retry explicitly.
- A missing active project leaves other tabs usable and keeps the warning visible after workspace restoration.
- The audit runs as part of the native package workflow alongside the workspace and agent smoke tests.

## Verification boundaries

Native runtime checks on 24 November 2026 used macOS ARM64 and Ubuntu 24.04 ARM64 in an isolated VM. Both passed the audit, workspace, and agent smoke cases. Ubuntu AMD64 was checked with the packaged version probe under emulation. Windows AMD64 and ARM64 development installers were cross-built. Intel macOS, native Windows and Ubuntu AMD64 GUI runs, macOS account and workspace OAuth, live third-party keys, and production signing and publishing remain unverified. Interactive file dialogs were exercised on macOS. The update regression uses fixture versions `0.1.1` and `0.1.2` with engines `1.1.0` and `1.1.1`. The local dry run validated five installers and three update payloads. Go race tests, Go vet, the TypeScript build, and workflow lint passed.

The HTTP API exposes a fixed project, session creation and listing, runs, interactive input, and cancellation. The Desktop also supplies terminals and exports through its host. GoHarness has separate CLI or terminal UI workflows for portable archive import, session forks and salvage, snapshot restore, full profile editing, and MCP management. Project-configured hooks, budgets, skills, and integrations can act through the engine, with behavior specific to their configuration. This audit does not cover each combination of repositories, model settings, integrations, shell profiles, and OS policies. [GoHarness session recovery](https://github.com/Sanidhya14321/goh/blob/v1.1.0/docs/USER_GUIDE.md#sessions-and-recovery) · [GoHarness agents and profiles](https://github.com/Sanidhya14321/goh/blob/v1.1.0/docs/USER_GUIDE.md#agents-profiles-and-model-roles)

## Reproduce

After building or installing the development package as shown in the [README](../README.md), use a distinct work directory for each run.

```sh
python3 scripts/smoke.py out/dev-mac/goh-desktop-macos-universal.dmg --launcher --mode audit
python3 scripts/smoke.py out/dev-mac/goh-desktop-macos-universal.dmg --launcher --mode workspace
python3 scripts/smoke.py out/dev-mac/goh-desktop-macos-universal.dmg --launcher --mode measure

arch="$(dpkg --print-architecture)"
xvfb-run -a dbus-run-session -- python3 scripts/smoke.py \
  "out/dev-linux/goh-desktop-ubuntu-$arch.deb" --installed --launcher --mode audit
```

On Windows, use the development installer path with `python scripts/smoke.py <installer.exe> --mode audit`. This audit requires Git for its local checkout and worktree. The installed application has no new runtime dependency on Git for ordinary folders.

## Measurements

These single samples used Desktop `0.1.6` and GoHarness `1.1.0`. The host is a 15-core Apple M5 Pro with 24 GiB RAM and macOS 27.2.1. The Ubuntu 24.04 ARM64 guest used four vCPUs, 6 GiB allocated memory, and Xvfb. Cold ready is measured from the launcher to the first webview report. RSS sums the app, webview, and engine processes, so shared memory can be counted more than once.

| OS | Installer bytes | Cold ready | Idle RSS | Two active RSS |
| --- | ---: | ---: | ---: | ---: |
| macOS ARM64 | 24,624,384 | 648 ms | 194.39 MiB | 246.94 MiB |
| Ubuntu ARM64 | 8,518,512 | 728 ms | 670.21 MiB | 764.11 MiB |

Both measured process trees were empty after exit. The previous [harness report](../reports/Desktop%20harness%20features.md#packaged-results) records standalone measurements for the same prebuilt engine and hosts.
