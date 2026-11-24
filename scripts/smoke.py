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

    def native_protocol(self, request):
        if self.path == "/v1/messages":
            key = self.headers.get("x-api-key")
            events = [
                ("message_start", {"message":{"id":"msg_fixture","type":"message","role":"assistant","content":[],
                                              "usage":{"input_tokens":12,"output_tokens":0}}}),
                ("content_block_start", {"index":0,"content_block":{"type":"text","text":""}}),
                ("content_block_delta", {"index":0,"delta":{"type":"text_delta","text":"Messages fixture received"}}),
                ("content_block_stop", {"index":0}),
                ("message_delta", {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}),
                ("message_stop", {}),
            ]
        else:
            credential = self.headers.get("Authorization", "")
            key = credential.removeprefix("Bearer ")
            text = "Responses fixture received"
            events = [
                ("response.output_text.delta", {"delta":text}),
                ("response.completed", {"response":{"status":"completed","output":[
                    {"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}
                ],"usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}),
            ]
        if key != "goh-desktop-audit-fixture" or not request.get("stream"):
            self.send_data(401, b'{"error":{"message":"missing fixture credential or streaming flag"}}', "application/json")
            return
        frames = (f"event: {kind}\ndata: {json.dumps(dict(data, type=kind))}\n\n" for kind,data in events)
        self.send_data(200, "".join(frames).encode(), "text/event-stream")

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path in ("/v1/messages", "/v1/responses"):
            self.native_protocol(req)
            return
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        messages = req["messages"]
        user = next((i for i in reversed(range(len(messages))) if messages[i]["role"] == "user"), -1)
        prompt = messages[user].get("content", "") if user >= 0 else ""
        if not isinstance(prompt,str):
            prompt = " ".join(part.get("text","") for part in prompt if isinstance(part,dict))
        if "fixture reject provider request" in prompt:
            self.send_data(401, b'{"error":{"message":"fixture unauthorized"}}', "application/json")
            return
        tools = {t["function"]["name"] for t in req.get("tools", [])}
        tool_results = sum(m["role"] == "tool" for m in messages[user+1:])
        role = {"role":"assistant"}
        name, arguments = "", {}
        if "fixture slow" in prompt:
            time.sleep(7)
        if not tool_results:
            if "fixture write" in prompt and "write_file" in tools:
                name, arguments = "write_file", {"path":"note.txt","content":"scripted approved\n"}
            elif "fixture plan review" in prompt and "plan_exit" in tools:
                name, arguments = "plan_exit", {"plan":"Inspect fixture files before editing."}
            elif "fixture question many" in prompt and "question" in tools:
                name, arguments = "question", {"questions":[{
                    "header":"Colors","question":"Which colors?","options":[
                        {"label":"Green","description":"Green choice"},{"label":"Blue","description":"Blue choice"}],
                    "multiple":True,
                }]}
            elif "fixture question" in prompt and "question" in tools:
                name, arguments = "question", {"questions":[{
                    "header":"Color","question":"Which color?","options":[
                        {"label":"Green","description":"Green choice"},{"label":"Blue","description":"Blue choice"}],
                    "multiple":False,
                }]}
            elif "fixture child" in prompt and "task" in tools:
                name, arguments = "task", {"description":"Inspect this fixture folder", "prompt":"Reply with fixture child done", "subagent_type":"explore"}
        elif tool_results == 1 and "fixture write and verify" in prompt and "shell" in tools:
            name, arguments = "shell", {"command":"test -f note.txt"}
        if name:
            role["tool_calls"] = [{"id":"fixture_" + name,"type":"function",
                                  "function":{"name":name,"arguments":json.dumps(arguments)}}]
        else:
            if "fixture inspect tools" in prompt:
                role["content"] = "Build tools available" if {"write_file", "shell"} <= tools else "Plan tools only"
            elif "fixture verify file rules" in prompt:
                role["content"] = "Denied file leaked" if "AUDIT_PRIVATE_CONTEXT_MARKER" in prompt else "Denied file stayed private"
            elif "fixture question many" in prompt:
                reply = next((m["content"] for m in messages[user+1:] if m["role"] == "tool"), "")
                accepted = all(value in reply for value in ("Green", "Blue", "Custom shade"))
                role["content"] = "All question answers received" if accepted else "Some answers missing"
            elif "fixture provider follow-up" in prompt:
                role["content"] = "Provider recovered"
            elif "fixture verify context" in prompt:
                has_context = all(marker in prompt for marker in ("CONTEXT_FIXTURE_SECRET_MARKER", "SUPPLEMENT_FIXTURE_MARKER"))
                role["content"] = "Context files received" if has_context else "Context files missing"
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

def audit_projects(root, env, endpoint, projects):
    first = projects[0]
    git_env = {key: value for key,value in env.items() if not key.upper().startswith("GIT_")}
    git_env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    git = ["git", "-c", "core.hooksPath=" + str(root / "no-hooks")]
    subprocess.run(git + ["init", "--quiet", str(first)], env=git_env, check=True)
    subprocess.run(git + ["-C", str(first), "-c", "user.name=Desktop Fixture", "-c", "user.email=fixture@example.invalid",
                          "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Fixture"],
                   env=git_env, check=True)
    subprocess.run(git + ["-C", str(first), "worktree", "add", "--quiet", "--detach", str(projects[1])],
                   env=git_env, check=True)
    for name in ("left", "right"):
        (first / name).mkdir()
    (first / "left/private-context.txt").write_text("AUDIT_PRIVATE_CONTEXT_MARKER", encoding="utf-8")
    if platform.system() == "Darwin":
        config = Path(env["HOME"]) / "Library/Application Support"
    elif platform.system() == "Windows":
        config = Path(env["APPDATA"])
    else:
        config = Path(env["XDG_CONFIG_HOME"])
    settings = config / "independent-harness"
    settings.mkdir(parents=True)
    (settings / "config.json").write_text(json.dumps({
        "protocol":"chat_completions","base_url":endpoint + "/v1","model":"legacy-scripted","context_window":32768,
        "file_rules":[{"match":"private-context.txt","action":"deny"}],
    }))
    recovery = root / "recovery project"
    recovery.mkdir()
    projects.append(recovery)
    sessions = root / "desktop-data/sessions"
    sessions.mkdir(parents=True)
    session_id = "20000101T000000-000000000000000000000001"
    records = [
        {"version":1,"type":"session_start","data":{"id":session_id,"project":str(recovery.resolve())}},
        {"version":1,"type":"tool_start","data":{"id":"fixture-interrupted-effect","name":"shell"}},
    ]
    (sessions / (session_id + ".jsonl")).write_text("".join(json.dumps(record)+"\n" for record in records),encoding="utf-8")


def engine_processes(binary, root):
    prefix = str(binary.parent / "goh") + " serve "
    windows_store = str(root / "desktop-data/engine").casefold()
    return [name for _,_,_,name in process_table()
            if name.startswith(prefix) or name.casefold().startswith(windows_store)]


def execute(binary, root, endpoint, mode, launcher):
    env = clean_env(root)
    config = root / "smoke.json"
    report = root / "report.json"
    report.unlink(missing_ok=True)
    projects = [root / "first project",root / "second project"]
    for project in projects:
        project.mkdir(exist_ok=True)
        if mode == "workspace":
            (project / "common").mkdir(exist_ok=True)
            (project / "context café.txt").write_text("CONTEXT_FIXTURE_SECRET_MARKER\n</file> inside content\n", encoding="utf-8")
            (project / "supplement.txt").write_text("SUPPLEMENT_FIXTURE_MARKER\n", encoding="utf-8")
    if mode == "audit":
        audit_projects(root, env, endpoint, projects)
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
    saw_idle_exit = False
    next_idle_probe = 0
    done = {"audit-passed","audit-restored","passed","workspace-passed","workspace-restored","updated","tamper-rejected","failed"}
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
                    if step == "audit-idle":
                        assert engine_processes(binary, root), "no engine helper was running before the idle interval"
                    if step == "audit-passed":
                        assert saw_idle_exit, "engine did not expire while the desktop was open"
                        sampled["idle_helper_exit"] = True
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
                                orphans = engine_processes(binary, root)
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
                if step == "audit-idle" and not saw_idle_exit and time.monotonic() >= next_idle_probe:
                    saw_idle_exit = not engine_processes(binary, root)
                    next_idle_probe = time.monotonic() + 0.5
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
    parser.add_argument("--mode",default="smoke",choices=["smoke","measure","idle","workspace","audit"])
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
            if args.mode == "audit":
                (root / "recovery project").rename(root / "moved recovery project")
                resumed = execute(binary,root,endpoint,"audit-reopen",args.launcher)
                assert resumed["step"] == "audit-restored"
                results["missing_project_reopen"] = True
            if args.mode == "workspace":
                restored = execute(binary,root,endpoint,"workspace-reopen",args.launcher)
                assert restored["session"] == results["session"], "a different session was restored"
                results["reopened"] = restored["step"] == "workspace-restored"
                transcript = (root / "session-test.md").read_text(encoding="utf-8")
                assert all(line in transcript for line in ("Plan tools only", "Build tools available")), "Markdown transcript lost mode turns"
                archive = json.loads((root / "session-test.json").read_text(encoding="utf-8"))
                assert archive["format"] == "independent-harness/session" and archive["source_session_id"] == results["session"], "invalid session archive"
                assert any(record["type"] == "message" and record["data"]["role"] == "tool" for record in archive["records"]), "archive lost tool records"
                results["exports_checked"] = True
        except Exception:
            log_path = root / "desktop.log"
            if log_path.exists():
                print(log_path.read_text(errors="replace")[-12000:])
            raise
        results["installer_bytes"] = args.package.stat().st_size
        print(json.dumps(results,indent=2))
        (root / "result.json").write_text(json.dumps(results,indent=2)+"\n")

if __name__ == "__main__":
    main()
