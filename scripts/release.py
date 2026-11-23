#!/usr/bin/env python3
"""Validate a complete desktop release and publish the draft in one promotion."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

INSTALLERS = ["goh-desktop-macos-universal.dmg", "goh-desktop-ubuntu-amd64.deb",
              "goh-desktop-ubuntu-arm64.deb", "goh-desktop-windows-amd64-installer.exe",
              "goh-desktop-windows-arm64-installer.exe"]
PAYLOADS = {"darwin-universal":"goh-desktop-macos-universal-update.zip",
            "windows-amd64":"goh-desktop-windows-amd64-update.exe",
            "windows-arm64":"goh-desktop-windows-arm64-update.exe"}
TARGETS = ["darwin-universal","linux-amd64","linux-arm64","windows-amd64","windows-arm64"]

def command(*args):
    return subprocess.check_output([str(x) for x in args],text=True)

def version_ordinal(tag,preview):
    match = re.fullmatch(r"v0\.1\.(0|[1-9][0-9]{0,8})" + ("-preview" if preview else ""),tag)
    return int(match[1]) if match else -1

def engine_tuple(tag):
    if not re.fullmatch(r"v1\.(1|[2-9]|[1-9][0-9]+)\.(0|[1-9][0-9]*)",tag):
        raise ValueError("invalid compatible stable engine tag")
    return tuple(map(int,tag[1:].split(".")))

def sums(path):
    data = path.read_bytes()
    return len(data), hashlib.sha256(data).hexdigest()

def gh_api(repo,*args):
    return command("gh","api",*args,f"repos/{repo}/releases")

def prior_releases(repo):
    raw = gh_api(repo,"--paginate","--slurp")
    return [rel for page in json.loads(raw) for rel in page]

def guard(rels,tag,engine,preview):
    ordinal = version_ordinal(tag,preview)
    if ordinal == -1:
        raise ValueError("unrecognized desktop release tag")
    for release in rels:
        if release["draft"] or release["prerelease"] != preview:
            continue
        other = version_ordinal(release["tag_name"],preview)
        if other >= ordinal:
            raise RuntimeError("release would move the desktop channel backward or overwrite a published version")
        if not preview and other >= 0:
            previous = re.search(r"(?m)^Engine: (v\d+\.\d+\.\d+)$",release["body"] or "")
            if not previous:
                raise RuntimeError("published stable version does not record its bundled engine")
            if engine_tuple(previous[1]) > engine_tuple(engine):
                raise RuntimeError("release would downgrade the bundled engine for stable users")

def collect(artifacts,engine,version,publish):
    all_files = [p for p in artifacts.rglob("*") if p.is_file()]
    expected = INSTALLERS + list(PAYLOADS.values()) + ["engine-" + t + ".json" for t in TARGETS]
    inventory = Counter(p.name for p in all_files)
    if inventory != Counter(expected):
        raise RuntimeError(f"incomplete release asset set: missing {set(expected)-set(inventory)}, unexpected or duplicate {dict(inventory-Counter(expected))}")
    files = {p.name:p.resolve() for p in all_files}
    metadata = {}
    for target in TARGETS:
        meta = json.loads(files["engine-" + target + ".json"].read_text())
        inputs = {"darwin-universal":{"goh-darwin-amd64","goh-darwin-arm64"}}.get(target,{"goh-"+target+(".exe" if target.startswith("windows-") else "")})
        digests = meta["verified_upstream_sha256"]
        if (meta["engine_tag"] != engine or set(digests) != inputs or
                any(not re.fullmatch(r"[0-9a-f]{64}",d) for d in digests.values()) or
                not re.fullmatch(r"[0-9a-f]{64}",meta.get("bundled_sha256","")) or
                meta.get("desktop_version") != version or
                (publish and (meta["provenance"] != "github-attestation" or meta.get("build_mode") != "release"))):
            raise RuntimeError("invalid upstream engine build record for " + target)
        metadata[target] = meta
    return files,metadata

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--artifacts",required=True,type=Path)
    p.add_argument("--output",required=True,type=Path)
    p.add_argument("--repo",required=True)
    p.add_argument("--commit",required=True)
    p.add_argument("--version",required=True)
    p.add_argument("--engine-tag",required=True)
    p.add_argument("--channel",choices=["stable","preview"],required=True)
    p.add_argument("--publish",action="store_true")
    args = p.parse_args()
    preview = args.channel == "preview"
    tag = "v" + args.version + ("-preview" if preview else "")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+",args.repo) or not re.fullmatch(r"[0-9a-f]{40}",args.commit) or version_ordinal(tag,preview) < 0:
        p.error("invalid desktop release repository, commit or version")
    engine_tuple(args.engine_tag)
    if args.publish:
        guard(prior_releases(args.repo),tag,args.engine_tag,preview)
    files,metadata = collect(args.artifacts,args.engine_tag,args.version,args.publish)
    args.output.mkdir(parents=True,exist_ok=True)
    index = args.output / "BUNDLED_ENGINES.json"
    index.write_text(json.dumps({"desktop_version":args.version,"channel":args.channel,
                                 "desktop_commit":args.commit,"engine_tag":args.engine_tag,
                                 "targets":metadata},indent=2)+"\n")
    checksums = args.output / "SHA256SUMS"
    manifest = args.output / "update.json"
    env = os.environ.copy()
    if not args.publish:
        import base64
        seed = os.urandom(32)
        env["DESKTOP_UPDATE_SEED"] = base64.b64encode(seed).decode("ascii")
        env.pop("DESKTOP_UPDATE_PUBLIC_KEY",None)
    elif not env.get("DESKTOP_UPDATE_PUBLIC_KEY"):
        raise RuntimeError("set DESKTOP_UPDATE_PUBLIC_KEY to the key pinned by package builds")
    subprocess.run([os.getenv("GO","go"),"run","./cmd/update-manifest","-version",args.version,
                    "-engine",args.engine_tag,"-channel",args.channel,"-output",str(manifest),
                    "-base",f"https://github.com/{args.repo}/releases/download/{tag}",
                    *[target+"="+str(files[name]) for target,name in PAYLOADS.items()]],env=env,check=True)
    publish_files = [files[name] for name in INSTALLERS + list(PAYLOADS.values())] + [index,manifest]
    fingerprints = {file.name:sums(file) for file in publish_files}
    checksums.write_text("".join(digest+"  "+name+"\n" for name,(_,digest) in sorted(fingerprints.items())))
    sig = args.output / "SHA256SUMS.sig"
    subprocess.run([os.getenv("GO","go"),"run","./cmd/update-manifest","-sign-checksums",checksums],env=env,check=True)
    publish_files.extend([checksums,sig])
    fingerprints[checksums.name] = sums(checksums)
    fingerprints[sig.name] = sums(sig)
    if not args.publish:
        print(f"Dry run validated {len(fingerprints)} assets for {tag}. No remote changes.")
        return

    repo = args.repo
    existing = next((r for r in prior_releases(repo) if r["tag_name"] == tag),None)
    if existing:
        if not existing["draft"] or existing["target_commitish"] != args.commit:
            raise RuntimeError("existing release is not this commit's draft")
    else:
        with tempfile.NamedTemporaryFile("w",suffix=".md") as notes:
            notes.write(f"GoHarness Desktop {args.version}\n\nEngine: {args.engine_tag}\n\n"
                        "See BUNDLED_ENGINES.json for exact upstream inputs and SHA256SUMS for downloads.\n")
            notes.flush()
            cmd = ["gh","release","create",tag,"--repo",repo,"--draft","--latest=false",
                   "--target",args.commit,"--title",f"GoHarness Desktop {args.version}",
                   "--notes-file",notes.name]
            if preview:
                cmd.append("--prerelease")
            command(*cmd)
    command("gh","release","upload",tag,"--repo",repo,"--clobber",*publish_files)
    releases = prior_releases(repo)
    draft = next(r for r in releases if r["tag_name"] == tag)
    if not draft["draft"] or draft["target_commitish"] != args.commit:
        raise RuntimeError("release changed during asset upload")
    actual = {a["name"]:(a["size"],a.get("digest")) for a in draft["assets"] if a["state"] == "uploaded"}
    if actual != {name:(size,"sha256:"+digest) for name,(size,digest) in fingerprints.items()}:
        raise RuntimeError("draft assets do not match the complete verified local set")
    guard(releases,tag,args.engine_tag,preview)
    command("gh","release","edit",tag,"--repo",repo,"--draft=false",
            "--prerelease="+str(preview).lower(),"--latest="+str(not preview).lower())
    print("Published " + tag)

if __name__ == "__main__":
    main()
