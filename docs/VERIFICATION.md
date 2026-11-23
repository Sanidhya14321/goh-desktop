# Verification and performance

Verified on 23 November 2026 using development packages for Desktop `0.1.1` and the attested GoHarness release `v1.1.0`. The upstream checkout was left clean. No live provider credentials were used.

| Target | Verification |
| --- | --- |
| macOS arm64 | Mounted the universal DMG, copied the app to a temporary Applications folder and launched via LaunchServices. Passed fresh-profile smoke and version-to-version update. Verified both Mach-O slices in the app and helper and verified their ad hoc signatures. |
| macOS amd64 | Built and inspected the Intel slices in the universal app and helper. Intel GUI launch is covered by the native CI job and remains unverified locally. |
| Ubuntu 24.04.4 arm64 | Installed the actual `.deb` with APT on an ARM64 Ubuntu VM and launched its desktop entry with `gio launch` in Xvfb and a D-Bus session. Passed fresh-profile smoke with the system’s AppArmor namespace restriction and WebKit sandbox enabled. |
| Ubuntu 24.04 amd64 | Cross-built the `.deb` against an Ubuntu 24.04 x86-64 SDK and verified its package architecture and bundled version probe under emulation. Native GUI smoke remains for CI. |
| Windows amd64 and arm64 | Cross-built development NSIS installers and inspected the x64 and ARM64 GUI executable payloads. Native install, WebView2 launch, Authenticode and whole-install update remain for the Windows CI runners and signing environment. |

The packaged smoke exercises Go bindings through the real webview runtime. It confirms a clean provider profile, saves a scripted loopback provider, selects two fixture folders, and waits for simultaneous real engine permission challenges. The sibling session rejects a misplaced approval ID, only the allowed project gets the edit, and answers and child-agent events reach their original session. It cancels a run, reopens the journal and quits with a permission challenge pending. The automated scripts supply fixture folder paths through the same host selection method as the native picker. Interactive folder chooser behavior and real ChatGPT sign-in were not part of this local run.

The macOS update fixture uses a signed envelope and payload, an ad hoc signed universal app with its complete nested engine, and a local loopback update feed. It stages an update while a run is active, confirms restart is blocked, cancels the run and restarts into Desktop `0.1.2` plus the fixture engine `1.1.1`. The previous project and conversation reopen. Flipping a byte in the matching-size update payload causes digest verification to fail and leaves Desktop `0.1.1` and engine `1.1.0` runnable. Production Developer ID, notarization and Authenticode are pending credentials. The workflows passed Actionlint. A full local release assembly dry run used the five development installers and three updater payloads. GitHub-hosted jobs and publishing remain unrun.

## Measurements

Mac host was a MacBook Pro `Mac17,9`, Apple M5 Pro with 15 CPU cores and 24 GiB RAM, running macOS 27.2.1 (26B131) on arm64. Ubuntu was a Colima VZ ARM64 VM on the same Mac with 4 vCPUs and 6 GiB assigned RAM, using Xvfb.

| OS and run | Installer | Cold ready | Idle RSS | Two active RSS |
| --- | ---: | ---: | ---: | ---: |
| macOS arm64 desktop, universal DMG | 22.75 MiB | 1,069 ms | 178.53 MiB | 229.37 MiB |
| macOS arm64 standalone GoHarness | 13.83 MiB binary | 31.83 ms | 21.16 MiB | 46.30 MiB |
| Ubuntu arm64 desktop, APT install | 7.84 MiB | 784 ms | 637.25 MiB | 709.80 MiB |
| Ubuntu arm64 standalone GoHarness | 13.50 MiB binary | 7.06 ms | 16.94 MiB | 35.65 MiB |

Cold ready is wall-clock time from the OS launcher to the first webview report after the engine version and existing provider check are complete. Standalone cold ready measures process creation through authenticated `/v1/info`. The idle desktop starts no resident engine. Standalone idle is one running `goh serve`. Two-active readings use two engines waiting for scripted file approvals. The fixture model server runs outside the measured tree. Measures are single samples, with process RSS summed including shared pages. macOS WebKit XPC helpers are counted among services newly launched with the test app. Ubuntu includes the WebKit renderer, network and bubblewrap process tree. The large Ubuntu RSS reflects that software-rendered, virtualized WebKit run. Windows runtime memory and cold start await native measurements.

The raw smoke and standalone measurements are written to the local `out/verification` folder. Use the README commands to reproduce both workload and sampling. The `.deb` size excludes shared GTK and WebKit system dependencies.

## Local build notes

- The macOS archive initially kept AppleDouble files that made its signature seal fail after generic ZIP extraction. The updater restored the prior app. The packager now produces a plain archive and verifies the extracted bundle before publishing.
- Ubuntu’s default AppArmor policy blocked bubblewrap on the first install. The packaged, path-specific AppArmor profile resolved it with WebKit’s own sandbox enabled.
- Windows development installers use a 32-bit NSIS launcher and embed the intended native desktop and bundled engine. The build workflow must pass on the matching Windows runners before their stable download names are published.
