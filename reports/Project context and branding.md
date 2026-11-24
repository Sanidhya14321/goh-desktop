# Project context and app branding

## Research and plan

Zed exposes file context through `@` references in the message editor. VS Code also offers a context picker for users who already know which files the agent should see. GoHarness v1.1.0 accepts project-relative `@` references using Go string quoting, applies its existing file rules and attachment limits, and emits `files_attached` with the accepted paths. Desktop uses those interfaces with a native multi-select file picker that starts in the active project. It keeps the draft editable and shows filenames after the engine confirms inclusion. [Zed agent context](https://zed.dev/docs/ai/agent-panel#adding-context) · [VS Code chat context](https://code.visualstudio.com/docs/chat/copilot-chat-context#add-files-as-context) · [GoHarness file references](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/runtime/file_mentions.go)

The desktop badge uses the GoHarness website’s peach terminal glyph inside a dark frame. The same source SVG supplies the frontend, macOS ICNS, Ubuntu launcher SVG and PNGs, and Windows icon resources. The Windows installer points new shortcuts at the executable that already carries the icon, so the icon travels with future whole-executable updates. A shortcut from a previous Windows installation may still point at the old separate icon until the installer rewrites it.

## Behavior and verification

The picker accepts up to five files from the current project per selection. GoHarness appends up to five eligible UTF-8 files per prompt, with 64 KiB per file and 256 KiB total. Content is read by the engine on Send and can appear in transcript or archive exports. The desktop conversation shows filenames and preserves the original prompt text when it reloads the journal. [GoHarness attachment limits and access checks](https://github.com/Sanidhya14321/goh/blob/v1.1.0/internal/runtime/file_mentions.go)

Development packages for Desktop `0.1.5` and GoHarness `v1.1.0` passed the workspace fixture on macOS ARM64 and Ubuntu 24.04 ARM64. The test supplies fixture paths at the Go bridge and exercises the same path validation and draft insertion as the native picker. It rejects a file from the other project, passes two files to the scripted provider, and checks that the names survive reopening without rendering full file contents. The native picker itself and native Windows runtime remain outside this fixture.

- The universal macOS bundle passed strict ad hoc signature verification. Its ICNS includes seven sizes from 16 to 1,024 pixels. Intel GUI testing remains pending.
- The Ubuntu package installed 48- and 256-pixel PNG icons and the source SVG through the standard hicolor theme. The cross-built AMD64 package reported the expected versions under emulation.
- Both Windows installers cross-built. The AMD64 and ARM64 update executables contain all seven icon images in the resource that Wails uses.

Build and repeat the installed workspace fixture with the [README commands](../README.md). TypeScript, Go race tests, Go vet, and Actionlint passed.

## Performance

The measured development packages ran on macOS 27.2.1 on a 15-core Apple M5 Pro with 24 GiB RAM, and on an Ubuntu 24.04 ARM64 VM on the same Mac with four vCPUs and 6 GiB assigned RAM. Cold ready is the time to the first webview report. RSS sums the app, webview, and engine processes and can count shared pages more than once. Each row is one sample. Both packaged agent tests exercised two simultaneous approvals and cancellation. Both process trees were empty after quit.

| OS | Installer | Cold ready | Idle RSS | Two active RSS |
| --- | ---: | ---: | ---: | ---: |
| macOS ARM64 | 23.48 MiB | 696 ms | 194.17 MiB | 247.11 MiB |
| Ubuntu ARM64 under Xvfb | 8.12 MiB | 909 ms | 671.45 MiB | 744.95 MiB |

The [previous harness pass](Desktop%20harness%20features.md#packaged-results) records standalone measurements for the same prebuilt engine on both hosts. The local release dry run validated all five installers, three update payloads, and signed checksums with a fixture key.
