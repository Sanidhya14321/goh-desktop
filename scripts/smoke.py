#!/usr/bin/env python3
"""Launch an installed development package with a clean profile and scripted model."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class ScriptedModel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_data(self, status, body, kind):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        self.send_data(200, b'{"object":"list","data":[{"id":"scripted"}]}', "application/json")

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = req["messages"]
        user = next((i for i in reversed(range(len(messages))) if messages[i]["role"] == "user"), -1)
        prompt = messages[user].get("content", "") if user >= 0 else ""
        if not isinstance(prompt,str):
            prompt = " ".join(part.get("text","") for part in prompt if isinstance(part,dict))
        tools = {t["function"]["name"] for t in req.get("tools", [])}
        has_result = any(m["role"] == "tool" for m in messages[user+1:])
        role = {"role":"assistant"}
        name, arguments = "", {}
        if "fixture slow" in prompt:
            time.sleep(7)
        if not has_result:
            if "fixture write" in prompt and "write_file" in tools:
                name, arguments = "write_file", {"path":"note.txt","content":"scripted approved\n"}
            elif "fixture question" in prompt and "question" in tools:
                name, arguments = "question", {"questions":[{
                    "header":"Color","question":"Which color?","options":[
                        {"label":"Green","description":"Green choice"},{"label":"Blue","description":"Blue choice"}],
                    "multiple":False,
                }]}
            elif "fixture child" in prompt and "task" in tools:
                name, arguments = "task", {"description":"Inspect this fixture folder", "prompt":"Reply with fixture child done", "subagent_type":"explore"}
        if name:
            role["tool_calls"] = [{"id":"fixture_" + name,"type":"function",
                                  "function":{"name":name,"arguments":json.dumps(arguments)}}]
        else:
            role["content"] = "scripted response ✓"
        finish = "tool_calls" if name else "stop"
        usage = {"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
        if req.get("stream"):
            if name:
                role["tool_calls"][0]["index"] = 0
            chunks = [{"choices":[{"index":0,"delta":role,"finish_reason":None}]},
                      {"choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":usage}]
            body = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
            self.send_data(200, body.encode(), "text/event-stream")
        else:
            body = json.dumps({"choices":[{"index":0,"message":role,"finish_reason":finish}],"usage":usage})
            self.send_data(200, body.encode(), "application/json")

@contextlib.contextmanager
def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_port)
    finally:
        server.shutdown()
        server.server_close()

def clean_env(root):
    home = root / "home"
    config = home / "config"
    state = home / "state"
    appdata = home / "appdata"
    local = home / "local"
    for directory in (home,config,state,appdata,local,home / "Library/Application Support"):
        directory.mkdir(parents=True, exist_ok=True)
    prefixes = ("HARNESS_", "GOH_", "WAILS_", "OPENAI_", "ANTHROPIC_")
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(prefixes)}
    keys = {"HOME":home,"USERPROFILE":home,"XDG_CONFIG_HOME":config,
            "XDG_STATE_HOME":state,"APPDATA":appdata,"LOCALAPPDATA":local,
            "GOH_DESKTOP_DATA_DIR": root / "desktop-data"}
    env.update({k:str(v) for k,v in keys.items()})
    return env

def process_table():
    if platform.system() == "Windows":
        command = ("@(Get-CimInstance Win32_Process | Where-Object ExecutablePath | "
                   "Select-Object ProcessId,ParentProcessId,WorkingSetSize,ExecutablePath) | "
                   "ConvertTo-Json -Compress")
        raw = subprocess.check_output(["powershell.exe","-NoProfile","-NonInteractive","-Command",command],
                                      creationflags=subprocess.CREATE_NO_WINDOW)
        rows = json.loads(raw.decode("utf-8-sig",errors="replace"))
        return [(row["ProcessId"],row["ParentProcessId"],int(row["WorkingSetSize"] or 0)//1024,
                 row["ExecutablePath"]) for row in (rows if isinstance(rows,list) else [rows])]
    output = subprocess.check_output(["ps", "-ww", "-axo", "pid=,ppid=,rss=,command="], text=True)
    rows = []
    for line in output.splitlines():
        fields = line.strip().split(maxsplit=3)
        if len(fields) == 4:
            rows.append((int(fields[0]), int(fields[1]), int(fields[2]), fields[3]))
    return rows

def snapshot(binary, baseline, webkit=True):
    rows = process_table()
    if not rows:
        return {"rss_mib":None,"processes":[]}
    found = {pid for pid, _, _, name in rows if name.casefold().startswith(str(binary).casefold())}
    if webkit and platform.system() == "Darwin":
        # WebKit services are started by launchd. Include newly started
        # WebContent, Networking and GPU services from an isolated test.
        found |= {pid for pid, _, _, name in rows if pid not in baseline and "com.apple.WebKit." in name and ".xpc/" in name}
    while True:
        children = {pid for pid, parent, _, _ in rows if parent in found} - found
        if not children: break
        found |= children
    processes = [{"pid":pid,"rss_mib":round(rss/1024,2),"name":name.split("/Contents/MacOS/")[-1].split(" --")[0]}
                 for pid,_,rss,name in rows if pid in found]
    return {"rss_mib":round(sum(p["rss_mib"] for p in processes),2),"processes":processes}

@contextlib.contextmanager
def install(package,root,installed=False):
    system = platform.system()
    package = package.resolve()
    if system == "Darwin":
        data = subprocess.check_output(["hdiutil","attach","-nobrowse","-readonly","-plist",str(package)])
        entries = plistlib.loads(data)["system-entities"]
        mount = next(Path(entry["mount-point"]) for entry in entries if "mount-point" in entry)
        try:
            dest = root / "Applications/GoHarness Desktop.app"
            dest.parent.mkdir()
            subprocess.run(["ditto",str(mount / dest.name),str(dest)],check=True)
        finally:
            subprocess.run(["hdiutil","detach",str(mount),"-quiet"],check=True)
        yield dest / "Contents/MacOS/goh-desktop"
    elif system == "Linux":
        if installed:
            yield Path("/opt/goh-desktop/goh-desktop")
            return
        dest = root / "install"
        subprocess.run(["dpkg-deb","-x",str(package),str(dest)],check=True)
        yield dest / "opt/goh-desktop/goh-desktop"
    else:
        dest = root / "install"
        flags = [str(package), "/S", "/D="+str(dest)]
        subprocess.run(flags,check=True,timeout=90)
        try:
            yield dest / "goh-desktop.exe"
        finally:
            subprocess.run([str(dest / "uninstall.exe"),"/S"],timeout=60,check=True)

def execute(binary, root, endpoint, mode, launcher):
    env = clean_env(root)
    config = root / "smoke.json"
    report = root / "report.json"
    projects = [root / "first project",root / "second project"]
    for project in projects:
        project.mkdir(exist_ok=True)
    config.write_text(json.dumps({"projects":[str(p) for p in projects],"endpoint":endpoint+"/v1",
                                 "report":str(report),"mode":mode}))
    env["GOH_DESKTOP_SMOKE"] = str(config)
    baseline = {r[0] for r in process_table()}
    command = [str(binary)]
    if launcher and platform.system() == "Linux":
        command = ["gio","launch","/usr/share/applications/goh-desktop.desktop"]
    if launcher and platform.system() == "Darwin":
        command = ["open","-n","-W","--stdout",str(root / "desktop.log"),"--stderr",str(root / "desktop.log")]
        for key in ("HOME","XDG_CONFIG_HOME","XDG_STATE_HOME","GOH_DESKTOP_SMOKE","GOH_DESKTOP_DATA_DIR"):
            command += ["--env",key+"="+env[key]]
        command.append(str(binary.parents[2]))
    started = time.monotonic()
    sampled = {}
    interval = 0.06
    previous = ""
    staged = False
    deadline = started + 90
    done = {"passed","updated","tamper-rejected","failed"}
    with (root / "desktop.log").open("wb") as log:
        process = subprocess.Popen(command,env=env,stdout=log,stderr=log)
        try:
            while time.monotonic() < deadline:
                try:
                    state = json.loads(report.read_text())
                    step = state["step"]
                except (OSError,ValueError,KeyError):
                    step = ""
                if step and step != previous:
                    print(step, flush=True)
                    if step in ("ready","idle","two-active"):
                        if step in ("ready","idle"):
                            sampled["cold_start_ms"] = round((time.monotonic()-started)*1000)
                        sampled[step] = snapshot(binary,baseline)
                    if step in done:
                        if step != "failed":
                            process.wait(timeout=12)
                            if command[0] == "gio":
                                limit = time.monotonic() + 12
                                while time.monotonic() < limit and any(
                                    name.startswith(str(binary)) for _,_,_,name in process_table()
                                ):
                                    time.sleep(interval)
                                if any(name.startswith(str(binary)) for _,_,_,name in process_table()):
                                    raise RuntimeError("desktop launcher app did not quit")
                            if step == "passed":
                                sampled["after_exit"] = snapshot(binary,baseline)
                                prefix = str(binary.parent / "goh") + " serve "
                                windows_store = str(root / "desktop-data/engine").casefold()
                                orphans = [name for _,_,_,name in process_table() if
                                           name.startswith(prefix) or name.casefold().startswith(windows_store)]
                                assert not orphans, f"orphaned engine helpers: {orphans}"
                                assert (projects[0] / "note.txt").read_text() == "scripted approved\n"
                                assert not (projects[1] / "note.txt").exists()
                            return state | {"measurements":sampled}
                        raise RuntimeError(state.get("error",state))
                    if step == "idle":
                        return state | {"measurements":sampled}
                    if step == "staged":
                        staged = True
                    previous = step
                if process.poll() is not None and not staged:
                    # Give the report file one more pass after an orderly exit.
                    if not report.exists() and (command[0] != "gio" or process.returncode != 0):
                        raise RuntimeError(f"desktop exited early ({process.returncode})")
                time.sleep(interval)
            raise TimeoutError("packaged app did not finish its smoke test; last step: "+previous)
        finally:
            if command[0] in ("open", "gio"):
                for pid,_,_,name in process_table():
                    if name.startswith(str(binary)):
                        with contextlib.suppress(ProcessLookupError):
                            os.kill(pid,signal.SIGTERM)
            elif process.poll() is None:
                process.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=4)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package",type=Path)
    parser.add_argument("--work",type=Path)
    parser.add_argument("--mode",default="smoke",choices=["smoke","measure","idle"])
    parser.add_argument("--launcher",action="store_true")
    parser.add_argument("--installed",action="store_true",help="use the Ubuntu package already installed by APT")
    args = parser.parse_args()
    with contextlib.ExitStack() as stack:
        root = args.work.resolve() if args.work else Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        root.mkdir(parents=True, exist_ok=True)
        endpoint = stack.enter_context(serve(ScriptedModel))
        binary = stack.enter_context(install(args.package,root,args.installed))
        try:
            results = execute(binary,root,endpoint,args.mode,args.launcher)
        except Exception:
            print((root / "desktop.log").read_text(errors="replace")[-12000:])
            raise
        results["installer_bytes"] = args.package.stat().st_size
        print(json.dumps(results,indent=2))
        (root / "result.json").write_text(json.dumps(results,indent=2)+"\n")

if __name__ == "__main__":
    main()
