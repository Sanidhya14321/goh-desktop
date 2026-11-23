#!/usr/bin/env python3
"""Download exact release assets and verify each prebuilt engine."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

REPO = "Sanidhya14321/goh"

def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)

def asset_names(target):
    if target == "darwin-universal":
        return ["goh-darwin-amd64", "goh-darwin-arm64"]
    if not re.fullmatch(r"(darwin|linux|windows)-(amd64|arm64)", target):
        raise ValueError("unsupported target")
    return ["goh-" + target + (".exe" if target.startswith("windows-") else "")]

def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("target")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"v1\.(1|[2-9]|[1-9][0-9]+)\.(0|[1-9][0-9]*)", args.tag):
        raise SystemExit("supply the exact compatible stable upstream tag, e.g. v1.1.0")
    release = json.loads(gh("release", "view", args.tag, "--repo", REPO, "--json",
                            "tagName,isDraft,isPrerelease,publishedAt,url"))
    if release["tagName"] != args.tag or release["isDraft"] or release["isPrerelease"] or not release["publishedAt"]:
        raise SystemExit("upstream release is not published as stable")
    engines = asset_names(args.target)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.output) as name:
        stage = Path(name)
        names = ["SHA256SUMS", "LICENSE", "THIRD_PARTY_NOTICES", "licenses.tar.gz", *engines]
        command = ["release", "download", args.tag, "--repo", REPO, "--dir", str(stage)]
        for name in names:
            command += ["--pattern", name]
        gh(*command)
        checksums = {}
        for line in (stage / "SHA256SUMS").read_text().splitlines():
            fields = line.split()
            if len(fields) == 2 and re.fullmatch(r"[0-9a-f]{64}", fields[0]):
                if fields[1] in checksums:
                    raise SystemExit("upstream checksums contain a duplicate")
                checksums[fields[1]] = fields[0]
        for name in engines:
            binary = stage / name
            if checksums.get(name) != sha(binary):
                raise SystemExit("upstream checksum mismatch for " + name)
            subprocess.run(["gh", "attestation", "verify", str(binary), "--repo", REPO,
                            "--signer-workflow", REPO + "/.github/workflows/release.yml",
                            "--source-ref", "refs/tags/" + args.tag], check=True)
            binary.chmod(0o755)
        (stage / "engine-build.json").write_text(json.dumps({
            "engine_tag": args.tag, "source": release["url"],
            "verified_upstream_sha256": {name: checksums[name] for name in engines},
            "provenance": "github-attestation",
        }, indent=2) + "\n")
        for path in stage.iterdir():
            os.replace(path, args.output / path.name)

if __name__ == "__main__":
    main()
