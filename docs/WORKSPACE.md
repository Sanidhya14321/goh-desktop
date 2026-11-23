# Workspace redesign verification

The default Ember theme uses the GoHarness website’s Barlow typography, peach terminal mark, and charcoal surfaces. Graphite and High contrast add two dark alternatives. The webview uses the native window frame, menu roles, and folder picker. Command shortcuts use Cmd on macOS and Ctrl on Ubuntu and Windows. The terminal dock keeps a shell’s project fixed at launch and can display any two of the open terminals side by side.

## Tested on 24 November 2026

| Target | Result |
| --- | --- |
| macOS ARM64 | Installed and launched the universal development DMG. The native PTY and packaged workspace tests passed. The existing engine smoke and signed update fixture also passed. |
| Ubuntu 24.04 ARM64 | Upgraded the installed `.deb` with APT. The installed package passed the workspace and engine smoke tests in an Xvfb and D-Bus session with AppArmor and WebKit sandboxing enabled. |
| Ubuntu AMD64 | Cross-built against the Ubuntu 24.04 x86-64 SDK. The packaged version probe returned Desktop 0.1.2 and GoHarness 1.1.0 under emulation. Native GUI verification remains for the matrix job. |
| macOS Intel, Windows AMD64 and ARM64 | Built the Intel slices and both Windows development installers. The Windows shell uses ConPTY. GUI and ConPTY runtime verification remain for the native runners. |

The workspace fixture opens the palette, changes themes and density, and checks the saved preferences. It opens two terminals in different projects, checks real shell output and working directories, exercises split and close controls, renames a session, then relaunches and checks that the project, session, and theme were restored. The fixture supplies folder paths to the same selection routine used by the native picker. A Chromium preview with sample data was inspected at 1250×810 and 760×560. It complements the packaged webview tests.

On macOS, the redesigned DMG was 23.37 MiB. The installed engine fixture reached ready in 703 ms with 196 MiB idle RSS and 246 MiB with two active agent runs. The terminal dock was closed for those measurements, so the numbers exclude shells. The prior measurements and methodology are in [the phase-one report](VERIFICATION.md).

Run the workspace fixture against a built development package:

```sh
python3 scripts/smoke.py out/workspace-build/macos/goh-desktop-macos-universal.dmg \
  --launcher --mode workspace
```

On Ubuntu, install the package and run the same script with `--installed --launcher --mode workspace` under `xvfb-run -a dbus-run-session --`. On Windows, run it with the installer path and `--mode workspace`. The native CI matrix runs both the workspace and agent smoke tests.
