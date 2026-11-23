#!/usr/bin/env python3
"""Build a self-contained Wails package using a verified upstream engine directory."""
import argparse
import binascii
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import struct
import subprocess
import tempfile
import zlib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NOTICES = ["engine-build.json", "LICENSE", "THIRD_PARTY_NOTICES", "licenses.tar.gz"]
GO = os.getenv("GO", "go")

def run(*args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, cwd=ROOT, **kwargs)

def png_icon(size=256):
    def near_segment(x,y,ax,ay,bx,by):
        dx,dy = bx-ax,by-ay
        t = min(1,max(0,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)))
        return (x-ax-t*dx)**2+(y-ay-t*dy)**2 <= 2**2
    def pixel(x,y):
        x,y = (x+.5)*48/size,(y+.5)*48/size
        cx,cy = min(40,max(8,x)),min(40,max(8,y))
        inside = (x-cx)**2+(y-cy)**2 <= 8**2
        glyph = any(near_segment(x,y,*line) for line in ((11,15,21,24),(21,24,11,33),(26,33,36,33)))
        return bytes((42,27,20,255) if glyph else (239,173,131,255 if inside else 0))
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", binascii.crc32(name+data))
    pixels = b"".join(b"\0" + b"".join(pixel(x,y) for x in range(size)) for y in range(size))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR",struct.pack(">IIBBBBB",size,size,8,6,0,0,0))
            + chunk(b"IDAT",zlib.compress(pixels)) + chunk(b"IEND",b""))

def record_engine(args,binary):
    metadata = json.loads((args.engine / "engine-build.json").read_text())
    metadata.update(bundled_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                    desktop_version=args.version, build_mode="release" if args.release else "development")
    record = args.output / ("engine-" + args.target + ".json")
    record.write_text(json.dumps(metadata,indent=2)+"\n")
    return record

def copy_notices(engine,destination,record):
    for name in NOTICES:
        shutil.copy2(record if name == "engine-build.json" else engine / name,destination / name)
    module = subprocess.check_output([GO,"list","-m","-f","{{.Dir}}","github.com/wailsapp/wails/v3"],
                                     cwd=ROOT,text=True).strip()
    shutil.copyfile(Path(module) / "LICENSE",destination / "WAILS-LICENSE.txt")
    (destination / "DESKTOP-THIRD-PARTY.txt").write_text(dependency_licenses(),encoding="utf-8")

def dependency_licenses():
    notices = []
    for dependency in ("github.com/Kodecable/crosspty","github.com/creack/pty"):
        module = subprocess.check_output([GO,"list","-m","-f","{{.Dir}}",dependency],
                                         cwd=ROOT,text=True).strip()
        root = Path(module)
        licenses = [root / "LICENSE",*sorted((root / "licenses").glob("LICENSE*"))]
        for license in licenses:
            notices.append(dependency + " (" + license.name + ")\n" + license.read_text(encoding="utf-8"))
    for dependency in ("@xterm/xterm","@xterm/addon-fit","@fontsource/barlow","@fontsource/barlow-condensed"):
        license = ROOT / "frontend/node_modules" / dependency / "LICENSE"
        notices.append(dependency + "\n" + license.read_text(encoding="utf-8"))
    return "\n\n".join(notices)

def build(args, system, arch, output, tags="production"):
    env = os.environ | {"GOOS": system, "GOARCH": arch}
    if system == "darwin":
        env.update(CGO_ENABLED="1", MACOSX_DEPLOYMENT_TARGET="13.0",
                   CGO_CFLAGS="-mmacosx-version-min=13.0", CGO_LDFLAGS="-mmacosx-version-min=13.0")
    elif system == "windows":
        env["CGO_ENABLED"] = "0"
    else:
        env["CGO_ENABLED"] = "1"
    settings = [f"main.version={args.version}", f"main.engineVersion={args.engine_tag[1:]}",
                f"main.channel={args.channel}", f"main.development={int(not args.release)}",
                f"main.feedURL={args.feed}", f"main.updateKey={args.update_key}"]
    flags = "-s -w " + " ".join("-X " + s for s in settings)
    if system == "windows":
        flags += " -H windowsgui"
    run(GO,"build","-trimpath","-tags",tags,"-ldflags",flags,"-o",output,".",env=env)

def sign_mac(path, identity):
    options = ("--options","runtime","--timestamp") if identity != "-" else ("--timestamp=none",)
    run("codesign","--force","--sign",identity,*options,path)

def notarize(path):
    profile = os.environ["MAC_NOTARY_PROFILE"]
    result = subprocess.check_output(["xcrun","notarytool","submit",str(path),"--keychain-profile",profile,
                                      "--wait","--output-format","json"],text=True)
    status = json.loads(result)
    if status.get("status") != "Accepted":
        raise RuntimeError(f"notarization failed for {path}: {status}")

def mac(args):
    assets = args.output
    layout = assets / "layout"
    name = "GoHarness Desktop Preview" if args.channel == "preview" else "GoHarness Desktop"
    app = layout / (name + ".app")
    native = app / "Contents/MacOS"
    resources = app / "Contents/Resources"
    native.mkdir(parents=True)
    resources.mkdir()
    archs = ["amd64","arm64"] if args.target.endswith("universal") else [args.target.split("-")[1]]
    with tempfile.TemporaryDirectory() as tmp:
        slices = []
        for arch in archs:
            binary = Path(tmp) / ("desktop-" + arch)
            build(args,"darwin",arch,binary)
            slices.append(binary)
        for path, inputs in ((native / "goh-desktop", slices),
                             (native / "goh", [args.engine / ("goh-darwin-" + a) for a in archs])):
            if len(inputs) == 2:
                run("lipo","-create",*inputs,"-output",path)
                run("lipo",path,"-verify_arch","arm64","x86_64")
            else:
                shutil.copyfile(inputs[0],path)
            path.chmod(0o755)
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
        "CFBundleName":name, "CFBundleDisplayName":name,
        "CFBundleExecutable":"goh-desktop", "CFBundlePackageType":"APPL",
        "CFBundleIdentifier":"io.goharness.desktop." + args.channel,
        "CFBundleVersion":args.version, "CFBundleShortVersionString":args.version,
        "CFBundleIconFile":"AppIcon", "LSMinimumSystemVersion":"13.0",
        "NSHighResolutionCapable":True, "NSPrincipalClass":"NSApplication",
    }))
    icon = png_icon()
    (resources / "AppIcon.icns").write_bytes(b"icns" + struct.pack(">I",16+len(icon)) + b"ic08" + struct.pack(">I",8+len(icon)) + icon)
    identity = os.environ["MAC_SIGN_IDENTITY"] if args.release else "-"
    sign_mac(native / "goh",identity)
    record = record_engine(args,native / "goh")
    copy_notices(args.engine,resources,record)
    sign_mac(app,identity)
    if hashlib.sha256((native / "goh").read_bytes()).hexdigest() != json.loads(record.read_text())["bundled_sha256"]:
        raise RuntimeError("the engine bytes changed during bundle signing")
    run("codesign","--verify","--deep","--strict",app)
    prefix = "goh-desktop-macos-" + args.target.split("-")[1]
    archive = assets / (prefix + "-update.zip")
    run("ditto","-c","-k","--norsrc","--noextattr","--noqtn","--keepParent",app,archive)
    if args.release:
        notarize(archive)
        run("xcrun","stapler","staple",app)
        run("xcrun","stapler","validate",app)
        run("spctl","--assess","--type","execute",app)
        archive.unlink()
        run("ditto","-c","-k","--norsrc","--noextattr","--noqtn","--keepParent",app,archive)
    with tempfile.TemporaryDirectory() as inspection:
        run("unzip","-q",archive,"-d",inspection)
        unpacked = Path(inspection) / app.name
        run("codesign","--verify","--deep","--strict",unpacked)
        if args.release:
            run("xcrun","stapler","validate",unpacked)
    if not args.no_dmg:
        os.symlink("/Applications",layout / "Applications")
        disk = assets / (prefix + ".dmg")
        run("hdiutil","create","-quiet","-volname","GoHarness Desktop","-srcfolder",layout,"-format","UDZO","-ov",disk)
        if args.release:
            run("codesign","--force","--sign",identity,"--timestamp",disk)
            notarize(disk)
            run("xcrun","stapler","staple",disk)
            run("xcrun","stapler","validate",disk)
            run("codesign","--verify",disk)
        run("hdiutil","verify","-quiet",disk)

def linux(args):
    arch = args.target.split("-")[1]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp)
        name = "goh-desktop-preview" if args.channel == "preview" else "goh-desktop"
        target = path / "opt" / name
        target.mkdir(parents=True)
        build(args,"linux",arch,target / "goh-desktop")
        shutil.copyfile(args.engine / ("goh-linux-" + arch),target / "goh")
        (target / "goh").chmod(0o755)
        notices = path / "usr/share/doc" / name
        notices.mkdir(parents=True)
        copy_notices(args.engine,notices,record_engine(args,target / "goh"))
        desktop = path / "usr/share/applications"
        desktop.mkdir(parents=True)
        launcher = (ROOT / "packaging/goh-desktop.desktop").read_text()
        if args.channel == "preview":
            launcher = launcher.replace("Name=GoHarness Desktop", "Name=GoHarness Desktop Preview").replace("Exec=/opt/goh-desktop/", "Exec=/opt/goh-desktop-preview/").replace("Icon=goh-desktop", "Icon=goh-desktop-preview")
        (desktop / (name + ".desktop")).write_text(launcher)
        icon = path / "usr/share/icons/hicolor/256x256/apps"
        icon.mkdir(parents=True)
        (icon / (name + ".png")).write_bytes(png_icon())
        profiles = path / "etc/apparmor.d"
        profiles.mkdir(parents=True)
        profile = (ROOT / "packaging/ubuntu-apparmor.conf").read_text().replace("@PACKAGE@",name)
        (profiles / name).write_text(profile)
        debian = path / "DEBIAN"
        debian.mkdir()
        for script in ("postinst","prerm"):
            source = (ROOT / "packaging" / ("ubuntu-" + script)).read_text()
            (debian / script).write_text(source.replace("@PACKAGE@",name))
            (debian / script).chmod(0o755)
        (debian / "conffiles").write_text(f"/etc/apparmor.d/{name}\n")
        installed_size = sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) // 1024 + 1
        (debian / "control").write_text(f"""Package: {name}
Version: {args.version}
Architecture: {arch}
Maintainer: GoHarness <release@goharness.io>
Section: devel
Priority: optional
Installed-Size: {installed_size}
Depends: libgtk-4-1, libwebkitgtk-6.0-4, libglib2.0-0t64, apparmor, xdg-utils
Description: GoHarness desktop project sessions with a bundled engine
""")
        run("dpkg-deb","--root-owner-group","--build",path,args.output / f"goh-desktop-ubuntu-{arch}.deb")

def sign_windows(path):
    tool = os.getenv("SIGNTOOL", "signtool")
    client = os.getenv("WINDOWS_SIGNING_DLIB")
    if client:
        signing = ["/dlib",client,"/dmdf",os.environ["WINDOWS_SIGNING_METADATA"]]
    else:
        publisher = os.getenv("WINDOWS_CERT_THUMBPRINT")
        if not publisher or not re.fullmatch(r"[a-fA-F0-9]{40}",publisher):
            raise SystemExit("configure Artifact Signing or a signing certificate in CurrentUser\\My")
        signing = ["/sha1",publisher]
    timestamp = "http://timestamp.acs.microsoft.com" if client else "http://timestamp.digicert.com"
    run(tool,"sign",*signing,"/fd","SHA256","/tr",timestamp,"/td","SHA256",path)
    run(tool,"verify","/pa","/all",path)

def windows(args):
    arch = args.target.split("-")[1]
    with tempfile.TemporaryDirectory() as tmp:
        payload = Path(tmp)
        embedded = ROOT / "engine-windows.bin"
        embedded_notices = ROOT / "engine-windows-notices.bin"
        desktop = payload / "goh-desktop.exe"
        if embedded.exists() or embedded_notices.exists():
            raise SystemExit("remove stale Windows embed inputs before building")
        try:
            shutil.copyfile(args.engine / f"goh-windows-{arch}.exe",embedded)
            # Authenticode recognizes the PE bytes but uses the filename to select the SIP.
            if args.release:
                signed_engine = payload / "goh.exe"
                shutil.copyfile(embedded,signed_engine)
                sign_windows(signed_engine)
                shutil.copyfile(signed_engine,embedded)
            notices = payload / "notices"
            notices.mkdir()
            copy_notices(args.engine,notices,record_engine(args,embedded))
            with zipfile.ZipFile(embedded_notices,"w",compression=zipfile.ZIP_DEFLATED) as archive:
                for notice in sorted(notices.iterdir()):
                    archive.write(notice,notice.name)
            build(args,"windows",arch,desktop,"production,bundled")
        finally:
            embedded.unlink(missing_ok=True)
            embedded_notices.unlink(missing_ok=True)
        if args.release:
            sign_windows(desktop)
        icon = png_icon()
        (payload / "goh-desktop.ico").write_bytes(struct.pack("<HHHBBBBHHII",0,1,1,0,0,0,0,1,32,len(icon),22)+icon)
        prefix = args.output / ("goh-desktop-windows-" + arch)
        shutil.copy2(desktop,str(prefix)+"-update.exe")
        installer = str(prefix)+"-installer.exe"
        define = "/D" if platform.system() == "Windows" else "-D"
        run(os.getenv("MAKENSIS","makensis"),f"{define}PAYLOAD={payload}",f"{define}OUTPUT={installer}",
            f"{define}CHANNEL={args.channel}",ROOT / "packaging/windows.nsi")
        if args.release:
            sign_windows(installer)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target",required=True,choices=["darwin-universal","darwin-arm64","darwin-amd64",
                        "linux-amd64","linux-arm64","windows-amd64","windows-arm64"])
    parser.add_argument("--engine",type=Path,required=True)
    parser.add_argument("--engine-tag",required=True)
    parser.add_argument("--version",default="0.1.1")
    parser.add_argument("--channel",choices=["dev","stable","preview"],default="dev")
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--release",action="store_true")
    parser.add_argument("--feed",default="")
    parser.add_argument("--update-key",default="")
    parser.add_argument("--no-dmg",action="store_true")
    parser.add_argument("--cross-windows",action="store_true",help="build an unsigned Windows development installer using Unix NSIS")
    args = parser.parse_args()
    args.engine,args.output = args.engine.resolve(),args.output.resolve()
    target = args.target.split("-")[0]
    if target != {"Darwin":"darwin","Linux":"linux","Windows":"windows"}[platform.system()]:
        if target != "windows" or not args.cross_windows or args.release:
            parser.error("use the matching native operating system to package")
    if not re.fullmatch(r"0\.1\.(0|[1-9][0-9]{0,8})",args.version):
        parser.error("desktop version must be 0.1.N")
    if not re.fullmatch(r"v1\.(1|[2-9]|[1-9][0-9]+)\.(0|[1-9][0-9]*)",args.engine_tag):
        parser.error("desktop packages require a compatible engine tag")
    for value in (args.feed,args.update_key):
        if any(c.isspace() for c in value):
            parser.error("feed and key cannot contain whitespace")
    metadata = json.loads((args.engine / "engine-build.json").read_text())
    if metadata["engine_tag"] != args.engine_tag:
        parser.error("engine metadata does not match the requested version")
    names = (["goh-darwin-amd64","goh-darwin-arm64"] if args.target == "darwin-universal"
             else ["goh-" + args.target + (".exe" if target == "windows" else "")])
    verified = metadata.get("verified_upstream_sha256",{})
    for name in names:
        if verified.get(name) != hashlib.sha256((args.engine / name).read_bytes()).hexdigest():
            parser.error("engine input no longer matches its verified checksum: " + name)
    if args.release:
        if args.channel == "dev" or args.no_dmg or (target == "darwin" and args.target != "darwin-universal"):
            parser.error("publishable packages require a release channel and full distribution assets")
        if metadata.get("provenance") != "github-attestation":
            parser.error("publishable packages require verified upstream provenance")
        if target != "linux" and (not args.feed.startswith("https://") or not args.update_key):
            parser.error("publishable macOS and Windows packages require a pinned update key and HTTPS feed")
    args.output.mkdir(parents=True,exist_ok=True)
    {"darwin":mac,"linux":linux,"windows":windows}[target](args)

if __name__ == "__main__":
    main()
