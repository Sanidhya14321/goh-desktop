#!/usr/bin/env python3
"""Measure standalone GoHarness helpers with the same scripted approval workload."""
import argparse
import contextlib
import http.client
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

from smoke import ScriptedModel, clean_env, serve, snapshot

def request(address,token,method,path,payload=None):
    client = http.client.HTTPConnection(address,timeout=10)
    headers = {"Authorization":"Bearer "+token}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    client.request(method,path,None if payload is None else json.dumps(payload),headers)
    response = client.getresponse()
    if not 200 <= response.status < 300:
        raise RuntimeError(f"engine HTTP {response.status}: {response.read()}")
    return client,response

def helper(stack,binary,env,root,project,config):
    token = secrets.token_hex(32)
    started = time.monotonic()
    process = stack.enter_context(subprocess.Popen(
        [str(binary),"serve","--listen","127.0.0.1:0","--project",str(project),
         "--session-dir",str(root / "sessions"),"--config",str(config)],
        stderr=subprocess.PIPE,stdout=subprocess.DEVNULL,env=env | {"HARNESS_SERVER_TOKEN":token},text=True,
    ))
    stack.callback(terminate,process)
    announcement = process.stderr.readline().strip()
    prefix = "Harness API listening on "
    if not announcement.startswith(prefix):
        raise RuntimeError("engine failed to announce address: "+announcement)
    address = announcement[len(prefix):]
    connection,response = request(address,token,"GET","/v1/info")
    response.read()
    connection.close()
    return address,token,round((time.monotonic()-started)*1000,2)

def terminate(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            process.kill()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine",type=Path)
    args = parser.parse_args()
    binary = args.engine.resolve()
    with contextlib.ExitStack() as stack:
        root = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        endpoint = stack.enter_context(serve(ScriptedModel))
        env = clean_env(root)
        config = root / "engine.json"
        config.write_text(json.dumps({"protocol":"chat_completions","base_url":endpoint+"/v1",
                                      "model":"scripted","context_window":32768}))
        projects = [root / "project-one",root / "project-two"]
        for project in projects:
            project.mkdir()
        first = helper(stack,binary,env,root,projects[0],config)
        idle = snapshot(binary,set(),False)
        second = helper(stack,binary,env,root,projects[1],config)
        cancels = []
        for address,token,_ in (first, second):
            connection,response = request(address,token,"POST","/v1/sessions")
            session = json.load(response)["id"]
            connection.close()
            connection,response = request(address,token,"POST",f"/v1/sessions/{session}/run",{"prompt":"fixture write"})
            stack.callback(connection.close)
            run = response.getheader("X-Harness-Run-ID")
            while line := response.readline():
                frame = json.loads(line)
                if frame.get("input",{}).get("kind") == "permission":
                    break
            else:
                raise RuntimeError("fixture did not request approval")
            cancels.append((address,token,run))
        active = snapshot(binary,set(),False)
        for address,token,run in cancels:
            connection,response = request(address,token,"POST",f"/v1/runs/{run}/cancel")
            response.read()
            connection.close()
        print(json.dumps({"idle_one":idle,"active_two":active,"cold_first_ms":first[2],
                          "cold_second_ms":second[2],"engine_binary_bytes":binary.stat().st_size},indent=2))

if __name__ == "__main__":
    main()
