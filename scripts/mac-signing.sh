#!/usr/bin/env bash
set -euo pipefail
: "${MAC_CERT_P12:?}" "${MAC_CERT_PASSWORD:?}" "${MAC_NOTARY_API_KEY:?}" "${MAC_NOTARY_KEY_ID:?}" "${MAC_NOTARY_ISSUER:?}"
keychain="$RUNNER_TEMP/desktop-signing.keychain-db"
password="$(openssl rand -hex 24)"
printf '%s' "$MAC_CERT_P12" | base64 -D > "$RUNNER_TEMP/desktop.p12"
printf '%s' "$MAC_NOTARY_API_KEY" | base64 -D > "$RUNNER_TEMP/notary.p8"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security import "$RUNNER_TEMP/desktop.p12" -f pkcs12 -k "$keychain" -P "$MAC_CERT_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain"
xcrun notarytool store-credentials desktop-ci --keychain "$keychain" --key "$RUNNER_TEMP/notary.p8" --key-id "$MAC_NOTARY_KEY_ID" --issuer "$MAC_NOTARY_ISSUER"
security default-keychain -d user -s "$keychain"
printf 'MAC_NOTARY_PROFILE=desktop-ci\n' >> "$GITHUB_ENV"
rm -f "$RUNNER_TEMP/desktop.p12" "$RUNNER_TEMP/notary.p8"
