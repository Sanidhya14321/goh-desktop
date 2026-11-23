import { api, onFrames, type Challenge, type Frame, type Session, type Smoke } from "./api";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
type Match = (frame: Frame) => boolean;
const when = (id: string, match: Match) => new Promise<Frame>((resolve, reject) => {
  const timeout = window.setTimeout(() => { off(); reject(new Error("timed out waiting for " + id)); }, 22000);
  const off = onFrames((session, frames) => {
    if (session !== id) return;
    const found = frames.find(match);
    const failure = frames.find(f => f.end && f.error);
    if (!found && !failure) return;
    window.clearTimeout(timeout);
    off();
    if (found) resolve(found); else reject(new Error(failure!.error));
  });
});
const permission = (session: Session) => when(session.id, f => f.input?.kind === "permission").then(f => f.input as Challenge);
const ended = (session: Session) => when(session.id, f => !!f.end);

export async function runSmoke(config: Smoke, show: (line: string) => void) {
  const result: Record<string, unknown> = {};
  const report = async (step: string, quit = false) => {
    show(step);
    await api.report(JSON.stringify({ ...result, step }), quit);
  };
  try {
    result.versions = await api.versions();
    if (config.mode === "update-old" && (result.versions as { desktop: string }).desktop !== "0.1.1") {
      const prior = config.projects[0];
      assert((await api.projects()).includes(prior), "recent project did not survive the update");
      const sessions = await api.sessions(prior);
      assert(sessions.length > 0, "existing sessions did not reopen");
      const history = await api.history(sessions[0]);
      assert(history.messages.some(m => m.content.includes("scripted response")), "existing conversation did not reopen");
      await report("updated", true);
      return;
    }
    if (config.mode === "idle") { await report("idle"); return; }
    const existing = await api.provider();
    result.clean = !existing.model;
    assert(!existing.model, "fixture home contains a configured provider");
    await report("ready");
    if (config.mode === "measure") await new Promise(resolve => setTimeout(resolve, 500));
    await api.saveProvider({ protocol: "chat_completions", base_url: config.endpoint, model: "scripted" });
    const selected = await Promise.all(config.projects.map(p => api.select(p)));
    const [a, b] = await Promise.all(selected.map(p => api.create(p)));
    result.projects = selected;
    result.sessions = [a.id, b.id];
    if (config.mode.startsWith("update") || config.mode === "tampered") {
      const finished = ended(a);
      await api.start(a, "fixture update hello");
      assert(!(await finished).error, "fixture conversation failed");
      if (config.mode === "tampered") {
        let rejected = false;
        try { await api.stageUpdate(); } catch (err) { rejected = /digest|size mismatch|signature/i.test(String(err)); }
        assert(rejected, "tampered payload was not rejected");
        assert(await api.versions().then(v => v.desktop) === (result.versions as { desktop: string }).desktop, "running version changed after a failed update");
        await report("tamper-rejected", true);
        return;
      }
      const waiting = permission(a);
      const stopped = ended(a);
      await api.start(a, "fixture write");
      await waiting;
      const next = await api.stageUpdate();
      assert(next !== "", "no update staged");
      let guarded = false;
      try { await api.applyUpdate(); } catch (err) { guarded = /wait for active sessions/i.test(String(err)); }
      assert(guarded, "restart was allowed while a run was active");
      await api.cancel(a);
      await stopped;
      await report("staged");
      await api.applyUpdate();
      return;
    }
    const aApproval = permission(a);
    const bApproval = permission(b);
    const aDone = ended(a);
    const bDone = ended(b);
    await Promise.all([api.start(a, "fixture write"), api.start(b, "fixture write")]);
    const [ap, bp] = await Promise.all([aApproval, bApproval]);
    assert(ap.data.tool === "write_file" && bp.data.tool === "write_file", "wrong approval preview");
    assert(ap.data.preview?.includes("note.txt") && bp.data.preview?.includes("note.txt"), "missing proposed edit");
    await report("two-active");
    if (config.mode === "measure") await new Promise(resolve => setTimeout(resolve, 4500));
    let rejected = false;
    try { await api.answer(b, ap.id, { allow: true }); } catch { rejected = true; }
    assert(rejected, "cross-session approval was accepted");
    await api.answer(a, ap.id, { allow: true });
    await api.answer(b, bp.id, { allow: false });
    assert(!(await aDone).error && !(await bDone).error, "an approval run failed");
    const question = when(a.id, f => f.input?.kind === "question");
    const questionDone = ended(a);
    await api.start(a, "fixture question");
    const challenge = (await question).input!;
    await api.answer(a, challenge.id, { answers: [["Green"]] });
    assert(!(await questionDone).error, "question run failed");
    const child = when(a.id, f => f.event?.type === "subagent_started");
    const childFinished = when(a.id, f => f.event?.type === "subagent_finished");
    const childDone = ended(a);
    const offTask = onFrames((id, frames) => {
      if (id !== a.id) return;
      for (const frame of frames) {
        if (frame.input?.kind === "permission" && frame.input.data.tool === "task") {
          void api.answer(a, frame.input.id, { allow: true });
        }
      }
    });
    await api.start(a, "fixture child");
    try { await Promise.all([child, childFinished]); } finally { offTask(); }
    assert(!(await childDone).error, "child run failed");
    const started = when(b.id, f => f.event?.type === "run_started");
    const cancelled = when(b.id, f => f.event?.type === "run_finished" && f.event.data?.status === "cancelled");
    const cancellationDone = ended(b);
    await api.start(b, "fixture slow");
    await started;
    await api.cancel(b);
    await Promise.all([cancelled, cancellationDone]);
    const history = await api.history(a);
    assert(history.messages.some(m => m.content.includes("scripted response")), "session journal did not reopen");
    const exitPending = permission(b);
    await api.start(b, "fixture write");
    await exitPending;
    await report("passed", true);
  } catch (err) {
    await api.report(JSON.stringify({ ...result, step: "failed", error: String(err) }), true);
  }
}
