# GoHarness Desktop

A standalone desktop app for GoHarness with a Wails v3 host, one native webview, and a TypeScript UI. The installers include GoHarness. Users launch the app from their OS launcher and can use it without a Go installation or a GoHarness command on PATH.

## Open a project

1. Install the package for your system and launch **GoHarness Desktop**. On macOS, drag the app from the DMG into Applications before opening it.
2. Open a folder. The newest session opens automatically when available. Choose **New** to start another, or select an existing session in the sidebar.
3. If needed, connect a provider in **Provider settings**. Use **Continue with ChatGPT** for browser OAuth, or enter the protocol, endpoint, model, context window and API key for an API or local provider. Existing GoHarness settings are used by default. **Use GoHarness settings** restores that selection after a desktop override.
4. Review approvals in the tab that requested them. The pane shows the engine’s proposed edit preview. A tool result appears after the engine executes the operation. Use **Cancel run** to stop a session and the child-agent pane to follow delegated work.

Two runs can be active across separate projects or Git worktrees. Two sessions in the same checkout share one writer slot. The app starts a helper on session creation or the first run, and retires it after 15 seconds without activity. The top bar shows the desktop version and the version reported by the installed engine.

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

The repository includes the [release and signing runbook](docs/RELEASE.md), the [upstream dispatch patch](docs/upstream-desktop-hook.patch), and the [verification and performance report](docs/VERIFICATION.md).
