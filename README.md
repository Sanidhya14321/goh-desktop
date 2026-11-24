# GoHarness Desktop

A standalone desktop app for GoHarness with a Wails v3 host, one native webview, and a TypeScript UI. The installers include GoHarness. Users launch the app from their OS launcher and can use it without a Go installation or a GoHarness command on PATH.

## Work in several projects

1. Launch **GoHarness Desktop** from the OS launcher. On macOS, drag the app from the DMG into Applications before opening it.
2. Use **Projects** to open a repository or folder. Pin frequently used folders, filter the list, and switch between projects without closing sessions and terminals from other folders.
3. Click **New session** to talk to GoHarness. If setup is needed, the app opens the provider dialog and returns to the requested project after setup. An empty session offers **Explain this project**, which fills the composer with an editable prompt. A terminal can be opened before a provider is set up. Use the **Needs input** control to jump to an approval or question in any open project.
4. Use the terminal button in the top bar to show the dock. The dock’s **+** opens a real shell in the selected project. Terminal tabs keep running when the dock is hidden or when another project is selected. Use **Split terminal view** to see two panes, and drag the top divider to resize the dock. Rename terminals from the dock and switch to them by name through the palette. Search scrollback in the active pane with the dock’s Find button.
5. Use **Workspace settings** to choose a dark theme, density, terminal font size, default shell, and panel visibility. Pinning, session names, and the selected project persist. With session restoration enabled, the app reopens those tabs on launch.

| Action | macOS | Ubuntu and Windows |
| --- | --- | --- |
| Command palette | Cmd+K or Cmd+Shift+P | Ctrl+K or Ctrl+Shift+P |
| Open project | Cmd+O | Ctrl+O |
| New terminal | Cmd+Shift+T | Ctrl+Shift+T |
| Workspace settings | Cmd+, | Ctrl+, |
| Send message | Cmd+Enter | Ctrl+Enter |
| Find in the focused terminal | Cmd+F | Ctrl+Shift+F |
| Copy or paste in a terminal | Cmd+C / Cmd+V | Ctrl+Shift+C / Ctrl+Shift+V |

When focused in an Ubuntu or Windows terminal, use Ctrl+Shift+K for the palette. The palette also offers terminal copy, paste, and scrollback clearing. Native menus expose the main workspace actions.

Two GoHarness runs can be active across separate projects or Git worktrees. Two sessions in the same checkout share one writer slot. Up to 12 interactive terminals can be open, with up to two visible in the dock. Terminals are user-operated OS shells and can edit the same files as GoHarness. Quit closes live terminals, and in-app updates wait for active runs and terminals to finish before restarting. Shell processes and their scrollback are tied to the current app launch.

## Development

Use Go 1.27.4, Node 22.23.4, npm, Python 3.9 or later, and an authenticated GitHub CLI for exact engine asset and provenance downloads. macOS builds need Xcode Command Line Tools. Ubuntu 24.04 builds need `build-essential pkg-config libgtk-4-dev libwebkitgtk-6.0-dev`. Windows 11 builds need NSIS on PATH or `MAKENSIS` set to its absolute path. Windows uses the system WebView2 Evergreen runtime.

From this repo:

```sh
npm --prefix frontend ci
npm --prefix frontend run build
go test -race ./...
go vet ./...
```

On this workspace’s Mac, the upstream checkout already contains the required Go toolchain. Set `PATH="$PWD/../goh/research/tooling/go/bin:$PATH"` before building if `go` is missing. The build and fixture scripts can also read an absolute tool path from `GO`.

### Build and test a development package

Run the pair of commands for your target with `v1.1.0` as the upstream release and `0.1.1` as the desktop version.

```sh
# macOS universal
python3 scripts/fetch-engine.py v1.1.0 darwin-universal .cache/engine-mac
python3 scripts/package.py --target darwin-universal --engine .cache/engine-mac --engine-tag v1.1.0 --version 0.1.1 --output out/dev-mac
python3 scripts/smoke.py out/dev-mac/goh-desktop-macos-universal.dmg --launcher --mode measure

# Ubuntu 24.04 or later, use amd64 or arm64 to match the machine
arch="$(dpkg --print-architecture)"
python3 scripts/fetch-engine.py v1.1.0 "linux-$arch" .cache/engine-linux
python3 scripts/package.py --target "linux-$arch" --engine .cache/engine-linux --engine-tag v1.1.0 --version 0.1.1 --output out/dev-linux
sudo apt install "./out/dev-linux/goh-desktop-ubuntu-$arch.deb"
xvfb-run -a dbus-run-session -- python3 scripts/smoke.py "out/dev-linux/goh-desktop-ubuntu-$arch.deb" --installed --launcher --mode measure
```

```powershell
# Windows PowerShell, set $arch to amd64 or arm64
$arch = "amd64"
python scripts/fetch-engine.py v1.1.0 "windows-$arch" .cache/engine-windows
python scripts/package.py --target "windows-$arch" --engine .cache/engine-windows --engine-tag v1.1.0 --version 0.1.1 --output out/dev-windows
python scripts/smoke.py "out/dev-windows/goh-desktop-windows-$arch-installer.exe"
```

Run `python3 scripts/update-smoke.py --target darwin-universal --engine .cache/engine-mac --upstream ../goh --work "$(mktemp -d /tmp/goh-desktop-update.XXXXXX)"` for the macOS version transition and tamper fixture. On Windows, use the same script with the native Windows target and a new work folder. The fixture uses an ephemeral signing key, the exact upstream source tag archived outside the engine checkout, and a locally stamped version for the new engine. To compare standalone process measurements, run `python3 scripts/measure-engine.py /absolute/path/to/goh`.

For an unpackaged development run, build the frontend, then run `GOH_DESKTOP_ENGINE=/absolute/path/to/goh go run .`. `GOH_DESKTOP_DATA_DIR` optionally selects a separate absolute development data directory. Production builds ignore both overrides.

### Local data and integration

Desktop settings and journals live under the OS user config directory in `GoHarness Desktop`. The preview channel uses `GoHarness Desktop Preview`. Windows caches its embedded engine and notices in a digest-named folder there and removes old cached versions after a successful start. Custom API keys are in a private per-user provider settings file and passed only to the engine through its supported API-key environment setting. Existing GoHarness provider config and browser OAuth credentials stay in GoHarness’s own user locations.

The Go host launches the engine by an absolute path and verifies its reported version. Each helper binds `127.0.0.1:0` and receives a fresh bearer token. The host authenticates `GET /v1/info`, checks the fixed project and session directory, and handles the NDJSON stream and input routes. The webview gets batched display events and the bounded recent portion of durable journals. It has no helper address or token. Exit cancels active streams and stops helpers.

The [existing-app research and UX plan](reports/Desktop%20workflow%20usability.md) explains the usability changes, and the [usability verification](docs/USABILITY-VERIFICATION.md) records the installed tests. The [workspace redesign verification](docs/WORKSPACE.md) records the latest checks. The repository also includes the [release and signing runbook](docs/RELEASE.md), the [upstream dispatch patch](docs/upstream-desktop-hook.patch), and the [verification and performance report](docs/VERIFICATION.md).
