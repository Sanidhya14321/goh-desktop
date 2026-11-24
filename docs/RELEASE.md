# Release and signing

## Preflight and promotion

1. Use a secret-free `desktop-dry-run` environment. Limit `mac-signing`, `windows-signing`, `linux-release` and `desktop-publish` for publishing from the default branch.
2. Run **Native build and smoke** for the exact engine tag. Its matrix installs and smokes macOS Apple Silicon and Intel, Ubuntu `amd64` and `arm64`, and Windows `amd64` and `arm64`. The macOS and Windows jobs also exercise the pinned update fixture. Review native results before distributing each target.
3. Dispatch **Desktop release** with the exact stable engine tag and `dry_run: true`. It builds development assets, verifies the required five-target inventory, generates test-signed update metadata, and uploads Actions artifacts. It leaves GitHub Releases untouched.
4. Configure signing and dispatch from the default branch with `dry_run: false`. The workflow uses desktop version `0.1.<run_number>`. It verifies the exact upstream release status, rejects prerelease tags, checks every engine asset against upstream SHA-256, and requires a GitHub attestation from the upstream release workflow for that tag. The original engine asset digests and the final bundled engine digest are captured in `BUNDLED_ENGINES.json` after universal assembly and code signing.
5. The promotion job checks the complete installer and updater inventory, signs its SHA-256 inventory, uploads the set to one draft, verifies every uploaded size and SHA-256 through the Releases API, then publishes the draft. Stable promotion uses one serialized job and rejects retries or out-of-order versions that would replace an existing release or regress the desktop or engine version. A failed build or upload leaves the preceding stable release available. A retry may resume its own draft. The preview channel publishes a GitHub prerelease with a `-preview` suffix and its own signed feed.

Stable download names are `goh-desktop-macos-universal.dmg`, `goh-desktop-ubuntu-{amd64,arm64}.deb`, and `goh-desktop-windows-{amd64,arm64}-installer.exe`. The update payloads are `goh-desktop-macos-universal-update.zip` and `goh-desktop-windows-{amd64,arm64}-update.exe`. For stable installs the feed is `releases/latest/download/update.json`. Preview builds select the highest published desktop prerelease from the repo API and verify its manifest channel before downloading any payload. The desktop repository must be publicly readable for these feeds as configured.

Manual dispatch example after pushing the repo:

```sh
gh workflow run release.yml --repo OWNER/goh-desktop --ref main \
  -f engine_tag=v1.1.0 -f channel=stable -f dry_run=true
```

To validate an already assembled set of local development packages without Actions, place only the five installers and three updater payloads and five `engine-*.json` records under one directory. Use the same desktop version and upstream tag for all elements.

```sh
python3 scripts/release.py --artifacts out/release-inputs --output out/release-dry-run \
  --repo OWNER/goh-desktop --commit "$(git rev-parse HEAD)" --version 0.1.1 \
  --engine-tag v1.1.0 --channel stable
```

## Credentials

### Update signing

Run `go run ./cmd/update-manifest -generate` in a trusted terminal. Set the repository variable `DESKTOP_UPDATE_PUBLIC_KEY` to the printed public key and the `desktop-publish` environment secret `DESKTOP_UPDATE_SEED` to the seed. The key is pinned at build time. It also signs `SHA256SUMS.sig` over the release checksum inventory, which includes the Ubuntu packages. With a trusted copy of the pinned public key and the two downloaded checksum files, run `DESKTOP_UPDATE_PUBLIC_KEY=<public-key> go run ./cmd/update-manifest -verify-checksums SHA256SUMS` before checking the asset hashes. The publisher verifies the seed matches the pin. Plan key rotation through a trusted transition build before retiring the old key.

The feed is a signed envelope over the exact manifest bytes. That signed manifest binds the desktop version, channel, engine tag, target, size, URL and artifact digest. The Wails updater independently verifies the downloaded SHA-256 and Ed25519 payload signature. On macOS, staging checks the full app bundle signature and inspects both reported versions. On Windows, the signed replacement executable is self-contained and embeds the signed engine and its notices. The running app materializes only the engine matching its own embedded digest, and a successful startup retires the old extracted copy. The app applies updates from the **Updates** panel only when all runs and provider authentication are idle. Wails stages beside the install, waits for the original process to exit, and keeps a rollback copy during replacement. Install the app in a location writable by the user applying the update. Update helper diagnostics are in `wails-update-*.log` under the OS temp location.

### macOS

Configure `mac-signing` with `MAC_SIGN_IDENTITY` as an environment variable such as `Developer ID Application: Example (TEAMID)`. Provide secrets `MAC_CERT_P12` (base64 PKCS#12), `MAC_CERT_PASSWORD`, `MAC_NOTARY_API_KEY` (base64 .p8), `MAC_NOTARY_KEY_ID`, and `MAC_NOTARY_ISSUER`. The workflow imports the certificate into a temporary keychain. The packager signs the nested universal engine, then the outer app, notarizes and staples the app, verifies the extracted update archive, and signs, notarizes and staples the DMG. The update archive uses ordinary ZIP entries so extraction preserves the signature seal. [Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)

The local development DMG uses ad hoc signing. A local production-equivalent build can use an installed Developer ID identity and an existing notarytool keychain profile through `MAC_SIGN_IDENTITY` and `MAC_NOTARY_PROFILE`, plus the packager’s `--release --channel stable --update-key ... --feed ...` options.

### Windows

Give a Microsoft Artifact Signing certificate profile a federated Azure identity scoped to the `windows-signing` environment. Assign the Artifact Signing certificate profile signing role. Set environment variables `AZURE_SIGNING_CLIENT_ID`, `AZURE_SIGNING_TENANT_ID`, `AZURE_SIGNING_SUBSCRIPTION_ID`, `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_PROFILE`, and `ARTIFACT_SIGNING_CLIENT_VERSION` (the exact tested NuGet version of `Microsoft.Trusted.Signing.Client`). The workflow signs and verifies the nested engine, self-contained executable, and per-user installer using SignTool and RFC 3161 timestamping. For a local native release build with a hardware-backed certificate in CurrentUser\My, set `WINDOWS_CERT_THUMBPRINT` and `SIGNTOOL` instead. Verify the OS launch, WebView2 runtime and complete production update on Windows before promoting. [Microsoft Artifact Signing integrations](https://learn.microsoft.com/azure/artifact-signing/how-to-signing-integrations) · [SignTool](https://learn.microsoft.com/windows/win32/seccrypto/signtool)

### Ubuntu

The `.deb` installs with APT and depends on the system GTK4 and WebKitGTK 6.0 stack. It includes an AppArmor profile for the packaged WebKit host on Ubuntu 24.04 so bubblewrap can create the webview sandbox. The engine receives the ordinary unconfined-label policy. The package uses the system’s existing AppArmor service and does not change kernel-wide namespace settings. [Ubuntu 24.04 AppArmor behavior](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions)

For ongoing upgrades, publish fully verified stable `.deb` files to a signed APT repository. For example, configure `reprepro` with `Codename: noble`, `Components: main`, `Architectures: amd64 arm64`, and `SignWith: <APT key fingerprint>`. Include both packages with `reprepro -b /srv/goh-apt includedeb noble <downloaded package>`, then publish the resulting signed `InRelease`, package indexes and pool together at an HTTPS URL. Serve the public APT key separately and verify its fingerprint out of band. Users install it at `/etc/apt/keyrings/goh-desktop.gpg` and add a deb822 source:

```text
Types: deb
URIs: https://packages.example.org/goh-desktop
Suites: noble
Components: main
Signed-By: /etc/apt/keyrings/goh-desktop.gpg
```

Run `sudo apt update && sudo apt install goh-desktop`, then upgrade through APT. Keep preview in a separate suite with the `goh-desktop-preview` package name. APT signing uses its own key. Automatic in-app Linux replacement would require a separately tested AppImage channel with a user-writable install and the engine inside its signed payload. Phase 1 uses APT. [Ubuntu package guidance](https://documentation.ubuntu.com/security/common-mistakes/deb-download-archive/)

## Automatic release checks

The [Desktop release workflow](../.github/workflows/release.yml) checks the latest public stable [GoHarness engine release](https://github.com/Sanidhya14321/goh/releases/latest) every six hours. It resolves the exact tag before packaging. When the engine advances within the supported 1.x range, a successful scheduled dry run updates `engine-version.txt`. Pull requests and pushes use that verified pin for native CI.

Set the repository Actions variable `DESKTOP_AUTO_PUBLISH=true` after configuring and verifying the signing environments above. Scheduled runs then publish signed stable Desktop releases when the public Desktop release needs a newer engine. The publisher checks the existing release before promotion and rejects engine downgrades. A manual dispatch can pick an exact stable tag or use the latest stable engine.

The [website’s GitHub workflow](https://github.com/Sanidhya14321/goh-website/blob/main/.github/workflows/sync-releases.yml) reads the public stable Desktop release and its recorded engine tag. It updates the live [download page](https://goh-website-three.vercel.app/downloads/#desktop) when the full installer set is published.
