#!/usr/bin/env python3
"""Build, install and update a native development package with a pinned fixture key."""
import argparse
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile

from smoke import ScriptedModel, execute, install, serve

ROOT = Path(__file__).resolve().parents[1]
GO = os.getenv("GO","go")

def run(*args,**kwargs):
    subprocess.run([str(a) for a in args],cwd=ROOT,check=True,**kwargs)

def setup_engine(work,engine,upstream,target):
    upstream_tag = json.loads((engine / "engine-build.json").read_text())["engine_tag"]
    major, minor, patch = map(int,upstream_tag[1:].split("."))
    next_tag = f"v{major}.{minor}.{patch+1}"
    source = work / "engine-source"
    source.mkdir()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git","-C",str(upstream),"archive",upstream_tag],stdout=archive,check=True)
        archive.seek(0)
        # This is a Git archive of the trusted engine release checkout.
        with tarfile.open(fileobj=archive) as contents:
            contents.extractall(source)
    fixture = work / "fixture-engine"
    shutil.copytree(engine,fixture)
    names = (["goh-darwin-amd64","goh-darwin-arm64"] if target == "darwin-universal"
             else ["goh-"+target+(".exe" if target.startswith("windows-") else "")])
    digests = {}
    for name in names:
        system,arch = name.removeprefix("goh-").removesuffix(".exe").split("-")
        env = os.environ | {"CGO_ENABLED":"0","GOOS":system,"GOARCH":arch}
        binary = fixture / name
        binary.unlink(missing_ok=True)
        subprocess.run([GO,"build","-trimpath","-ldflags","-s -w -X main.version="+next_tag[1:],
                        "-o",str(binary),"./cmd/harness"],cwd=source,env=env,check=True)
        digests[name] = hashlib.sha256(binary.read_bytes()).hexdigest()
    (fixture / "engine-build.json").write_text(json.dumps({
        "engine_tag":next_tag,"verified_upstream_sha256":digests,"provenance":"locally-built-fixture",
        "source_tag":upstream_tag,
    }))
    return fixture,upstream_tag,next_tag

class UpdateHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*_):
        pass

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine",required=True,type=Path)
    parser.add_argument("--upstream",required=True,type=Path)
    parser.add_argument("--target",required=True,choices=["darwin-universal","windows-amd64","windows-arm64"])
    parser.add_argument("--work",required=True,type=Path)
    args = parser.parse_args()
    work = args.work.resolve()
    work.mkdir(parents=True,exist_ok=True)
    engine = args.engine.resolve()
    fixture,old_tag,next_tag = setup_engine(work,engine,args.upstream.resolve(),args.target)
    key_data = subprocess.check_output([GO,"run","./cmd/update-manifest","-generate"],cwd=ROOT,text=True)
    key = dict(pair.split("=",1) for pair in key_data.splitlines())
    channel = "dev"
    feed = work / "feed"
    feed.mkdir()
    good = feed / "good"
    bad = feed / "bad"
    good.mkdir()
    bad.mkdir()
    update_name = "goh-desktop-macos-universal-update.zip" if args.target == "darwin-universal" else f"goh-desktop-{args.target}-update.exe"
    shell_package = "goh-desktop-macos-universal.dmg" if args.target == "darwin-universal" else f"goh-desktop-{args.target}-installer.exe"
    fixture_server = functools.partial(UpdateHandler,directory=str(feed))
    with serve(fixture_server) as feed_url, serve(ScriptedModel) as model:
        common = [sys.executable,"scripts/package.py","--target",args.target,"--channel",channel,
                  "--feed",feed_url+"/update.json","--update-key",key["PUBLIC"]]
        run(*common,"--engine",fixture,"--engine-tag",next_tag,"--version","0.1.2","--output",work/"new",
            *(["--no-dmg"] if platform.system() == "Darwin" else []))
        run(*common,"--engine",engine,"--engine-tag",old_tag,"--version","0.1.1","--output",work/"old")
        payload = good / update_name
        shutil.copyfile(work / "new" / update_name,payload)
        for tampered in (True,False):
            name = "bad" if tampered else "good"
            run(GO,"run","./cmd/update-manifest","-version","0.1.2","-engine",next_tag,"-channel",channel,
                "-base",feed_url+"/"+name,"-output",feed/"update.json",args.target+"="+str(payload),
                env=os.environ | {"DESKTOP_UPDATE_SEED":key["SEED"]})
            if tampered:
                data = bytearray(payload.read_bytes())
                data[len(data)//2] ^= 1
                (bad / update_name).write_bytes(data)
            folder = work / name
            folder.mkdir()
            mode = "tampered" if tampered else "update-old"
            with install(work / "old" / shell_package,folder) as binary:
                result = execute(binary,folder,model,mode,False)
                want = {"desktop":"0.1.1" if tampered else "0.1.2",
                        "engine":old_tag[1:] if tampered else next_tag[1:],"channel":channel}
                if result["versions"] != want:
                    raise RuntimeError(f"unexpected installed versions {result['versions']}, expected {want}")
                (work / (name+"-result.json")).write_text(json.dumps(result,indent=2)+"\n")
                print(json.dumps(result,indent=2),flush=True)

if __name__ == "__main__":
    main()
