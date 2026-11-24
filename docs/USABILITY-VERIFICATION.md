# Usability pass verification

The [research and plan](../reports/Desktop%20workflow%20usability.md) compares the first-session, review, project navigation and terminal workflows in established apps. This pass keeps those changes in the existing GoHarness workspace design.

| Workflow | Packaged proof |
| --- | --- |
| Start the first session | A clean profile selects a project, opens New Session, saves the local scripted provider through the UI, and lands in the same project. The starter prompt stays editable and the session history stays empty until Send. |
| Respond across projects | Two separate projects wait on a real question and file approval. The global list preserves both items until resolved, opens the correct challenge, and keeps the draft from the other session. |
| Navigate projects | Two folders named `common` show their different parent paths. The platform’s Cmd/Ctrl+Shift+P opens the palette. The workspace reload restores the named session and theme. |
| Work in split terminals | Two actual shells print their own working directories and test markers. One is renamed and selected through the palette. Find matches its own output, reports that the other pane’s marker is absent, and returns focus to the same terminal on Escape. |

The Desktop `0.1.3` development package bundles GoHarness `1.1.0`. These workflows and the prior engine smoke passed on macOS ARM64 and Ubuntu 24.04 ARM64. Ubuntu AMD64 reported the expected desktop and engine versions under emulation. Windows AMD64 and ARM64 installers cross-built and contain the corresponding GUI executable payloads. Native Windows and Intel Mac GUI tests remain for the CI matrix. The first-session fixture uses the scripted provider and supplies the folder path programmatically.

The local Go tests, Go vet, TypeScript build, and workflow lint passed. Reproduce the packaged usability checks with `python3 scripts/smoke.py <development-installer> --mode workspace`. Add `--launcher` on macOS or `--installed --launcher` inside the Ubuntu Xvfb and D-Bus session.
