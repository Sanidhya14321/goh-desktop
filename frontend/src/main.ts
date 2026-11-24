import { api, onAuthURL, onCommand, onFrames, type Challenge, type EngineEvent, type Frame, type Reply, type RunContext, type RunMode, type RunSummary, type ExportFormat, type Session, type Workspace } from "./api";
import { runSmoke } from "./smoke";
import { icon } from "./icons";
import type { TerminalDock } from "./terminals";
import "@fontsource/barlow/latin-400.css";
import "@fontsource/barlow/latin-500.css";
import "@fontsource/barlow/latin-600.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

for (const placeholder of document.querySelectorAll<HTMLElement>("[data-icon]")) placeholder.replaceWith(icon(placeholder.dataset.icon!));

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, content = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}
function button(label: string, action: () => void, className = "quiet") {
  const node = element("button", label, className);
  node.type = "button";
  node.onclick = action;
  return node;
}
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const limit = (s: string, n = 8192) => s.length > n ? s.slice(0, n) + "\n…" : s;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Entry = { role: string; text: string; label?: string; files?: string[] };
type Child = { agent: string; status: string };
type Tab = {
  session: Session; entries: Entry[]; children: Map<string, Child>; toolNames: Map<string, string>;
  draft: string; partial: string; running: boolean; status: string; loading: boolean;
  mode: RunMode; runContext?: RunContext; runs: RunSummary[];
  input?: Challenge; error?: string; recovery?: unknown; sending?: { text: string; recovery?: unknown }; toolProgress?: string;
};
const defaults: Workspace = {
  project: "", pins: [], tabs: [], active: "", names: {}, modes: {}, theme: "ember", density: "comfortable",
  font_size: 13, terminal_size: 32, shell: "default", sidebar: true, activity: true, restore: true,
};
let prefs: Workspace = {...defaults};
let ready = false;
let hasProvider = false;
let creatingSession = false;
let pendingSessionProject = "";
let saved = Promise.resolve();
let filter = "";
let terminalDock: TerminalDock | undefined;
let terminalLoading: Promise<TerminalDock> | undefined;
const mac = /Mac/.test(navigator.platform);
const modifier = mac ? "⌘" : "Ctrl";
get("palette-key").textContent = mac ? "⌘ K" : "Ctrl K";
get("compose-key").textContent = modifier + " + Enter";
let projects: string[] = [];
let project = "";
let sessions: Session[] = [];
let active = "";
const tabs = new Map<string, Tab>();
let renderQueued = false;
let inputKey = "";
let previousTab = "";
let navigationKey = "";
const prompt = get<HTMLTextAreaElement>("prompt");
const transcript = get("messages");
const agentMode = get<HTMLSelectElement>("agent-mode");
const modeHelp: Record<RunMode, string> = {
  default: "Use the agent configured in GoHarness.",
  plan: "Investigate with read-only project tools.",
  build: "Use Build tools with the current GoHarness permissions.",
};

function announce(message = "") {
  const alert = get("alert");
  alert.hidden = !message;
  alert.textContent = message;
}

function action(task: () => PromiseLike<unknown>, target: (message: string) => void = announce) {
  return async () => {
    try { await task(); } catch (err) { target(errorText(err)); }
  };
}
function add(tab: Tab, entry: Entry) {
  tab.entries.push({ ...entry, text: limit(entry.text) });
  if (tab.entries.length > 180) tab.entries.splice(0, tab.entries.length - 180);
}

function persist() {
  if (!ready) return;
  const state = structuredClone({
    ...prefs, project, active,
    tabs: prefs.restore ? [...tabs.values()].map(tab => tab.session) : [],
  });
  saved = saved.catch(() => {}).then(async () => { await api.saveWorkspace(state); });
  void saved.catch(err => announce(errorText(err)));
}

function projectPaths() {
  return [...new Set([...prefs.pins, ...[...tabs.values()].map(tab => tab.session.project), ...projects])];
}

function projectParents(paths: string[]) {
  const segments = new Map(paths.map(path => [path, path.split(/[\\/]/).filter(Boolean)]));
  const parents = new Map<string, string>();
  for (const [path, parts] of segments) {
    const parent = parts.slice(0, -1);
    const shared = [...segments].filter(([other, otherParts]) =>
      other !== path && otherParts.at(-1)?.toLocaleLowerCase() === parts.at(-1)?.toLocaleLowerCase());
    if (!shared.length) continue;
    let depth = 1;
    const suffix = (segments: string[]) => segments.slice(-depth).join(" / ");
    while (depth < parent.length && shared.some(([, other]) => suffix(other.slice(0,-1)) === suffix(parent))) depth++;
    parents.set(path, suffix(parent) || path);
  }
  return parents;
}

function sessionLabel(session: Session) {
  if (Object.hasOwn(prefs.names, session.id)) return prefs.names[session.id];
  const parsed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-/.exec(session.id);
  if (!parsed) return "Session " + session.id.slice(-5);
  const date = new Date(parsed[1] + "-" + parsed[2] + "-" + parsed[3] + "T" + parsed[4] + ":" + parsed[5] + ":" + parsed[6] + "Z");
  if (!Number.isFinite(date.getTime())) return "Session " + session.id.slice(-5);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function iconButton(label: string, glyph: string, click: () => void, extra = "") {
  const b = button("", click, "icon-button " + extra);
  b.title = label;
  b.setAttribute("aria-label",label);
  b.append(icon(glyph));
  return b;
}

function openProject(path: string) { return action(async () => choose(await api.select(path)))(); }
function togglePin(path: string) {
  const already = prefs.pins.includes(path);
  if (!already && prefs.pins.length >= 25) { announce("You can pin up to 25 projects."); return; }
  prefs.pins = already ? prefs.pins.filter(item => item !== path) : [...prefs.pins,path];
  persist();
  drawNavigation();
}

function drawNavigation() {
  const key = JSON.stringify([projects, project, sessions, active, filter, prefs.pins, prefs.names,
    [...tabs.values()].map(tab => [tab.session.id, tab.running, tab.input?.id, !!tab.recovery])]);
  if (key === navigationKey) return;
  navigationKey = key;
  const allPaths = projectPaths();
  const parents = projectParents(allPaths);
  const paths = allPaths.filter(path => path.toLocaleLowerCase().includes(filter));
  const projectItems = paths.map(path => {
    const row = element("div","","project-row" + (path === project ? " current" : ""));
    const label = element("span","","project-label");
    label.append(element("span",nameOf(path),"item-title"));
    const parent = parents.get(path);
    if (parent) label.append(element("small",parent,"item-title project-parent"));
    const b = button("", () => { void openProject(path); }, "project");
    b.append(icon("folder"),label);
    b.title = path;
    b.setAttribute("aria-current", String(path === project));
    const pinned = prefs.pins.includes(path);
    const pin = iconButton(pinned ? "Unpin " + nameOf(path) : "Pin " + nameOf(path), "pin", () => togglePin(path), "pin-project");
    pin.setAttribute("aria-pressed",String(pinned));
    row.append(b);
    if (path === project) {
      row.append(iconButton("Open terminal in " + nameOf(path),"terminal",openProjectTerminal(path),"project-terminal"));
    }
    row.append(pin);
    return row;
  });
  get("projects").replaceChildren(...(projectItems.length ? projectItems : [element("p",filter ? "No matching projects" : "No recent projects","muted sidebar-empty")]));
  get("project-sessions").hidden = !project;
  get("existing").replaceChildren(...sessions.map(item => {
    const b = button("", action(() => open(item)), "session-item");
    b.append(icon("session"), element("span",sessionLabel(item),"item-title"));
    if (tabs.get(item.id)?.input) b.append(element("span","","attention-dot"));
    b.title = sessionLabel(item);
    b.setAttribute("aria-current", String(active === item.id));
    return b;
  }));
  if (project && !sessions.length) get("existing").append(element("p","No sessions yet","muted sidebar-empty"));
  get("tab-bar").hidden = !tabs.size && !project;
  get("tabs").replaceChildren(...Array.from(tabs.values(), tab => {
    const selected = active === tab.session.id;
    const wrap = element("div", "", selected ? "tab selected" : "tab");
    const marker = tab.input ? " · Needs input" : tab.running ? " · Running" : "";
    const title = nameOf(tab.session.project) + " / " + sessionLabel(tab.session);
    const select = button("", () => setActive(tab.session.id), "tab-select");
    select.append(icon("session"),element("span",title + marker,"item-title"));
    select.title = title + marker;
    select.setAttribute("aria-current", String(selected));
    if (tab.input) select.append(element("i","","attention-dot"));
    const close = iconButton("Close " + sessionLabel(tab.session), "close", () => closeTab(tab), "close-tab");
    close.disabled = tab.running;
    wrap.append(select, close);
    return wrap;
  }));
  const activeRuns = [...tabs.values()].filter(tab => tab.running).length;
  get("run-count").textContent = activeRuns ? activeRuns + (activeRuns === 1 ? " active run" : " active runs") : "";
  drawAttention();
}

function closeTab(tab: Tab) {
  if (tab.running) { announce("Cancel or finish this run before closing its tab."); return; }
  tabs.delete(tab.session.id);
  if (active === tab.session.id) {
    const next = [...tabs.values()].reverse().find(other => other.session.project === project);
    setActive(next?.session.id ?? "");
  } else {
    drawNavigation();
    persist();
  }
}

function setActive(id: string) {
  active = id;
  const tab = tabs.get(id);
  if (tab && project !== tab.session.project) {
    project = tab.session.project;
    sessions = [];
    void refreshSessions(project);
  }
  prompt.value = tab?.draft ?? "";
  inputKey = "";
  announce();
  drawNavigation();
  drawSession();
  persist();
}

async function refreshSessions(path: string) {
  try {
    const list = await api.sessions(path);
    if (project !== path) return;
    sessions = list;
    drawNavigation();
  } catch (error) { if (project === path) announce(errorText(error)); }
}

async function choose(path: string) {
  if (!path) return;
  project = path;
  sessions = [];
  const existing = [...tabs.values()].reverse().find(other => other.session.project === path);
  setActive(existing?.session.id ?? "");
  const [nextProjects] = await Promise.all([api.projects(), refreshSessions(path)]);
  projects = nextProjects;
  drawNavigation();
  if (project === path && !active && sessions[0]) await open(sessions[0]);
}

async function open(session: Session) {
  if (tabs.has(session.id)) { setActive(session.id); return; }
  if (tabs.size >= 30) throw new Error("Close a session tab before opening another (limit 30).");
  const tab: Tab = { session, entries: [], children: new Map(), toolNames: new Map(), draft: "", partial: "", running: false, status: "Ready", loading: true, mode: prefs.modes[session.id] ?? "default", runs: [] };
  tabs.set(session.id, tab);
  setActive(session.id);
  try {
    const history = await api.history(session);
    tab.runs = history.runs ?? [];
    const latest = tab.runs.at(-1);
    if (latest) tab.status = runLabel(latest);
    if (history.truncated) add(tab, { role: "system", text: "Showing recent messages. The engine retains the full session journal." });
    for (const message of history.messages) add(tab, { role: message.role, text: message.content, files: message.files });
  } catch (error) {
    tab.error = errorText(error);
  } finally {
    tab.loading = false;
    if (active === session.id) drawSession();
  }
}

async function restoreWorkspace() {
  let prior = prefs.project;
  let missingProject = false;
  if (prior) {
    try {
      project = prior = await api.select(prior);
      await refreshSessions(project);
    } catch {
      project = prior = "";
      missingProject = true;
    }
  }
  const warnMissing = () => {
    if (missingProject) announce("The previously selected folder is unavailable. Choose another project.");
  };
  if (!prefs.restore) { warnMissing(); return; }
  // A missing folder must not prevent tabs from other projects from reopening.
  const groups = [...new Set(prefs.tabs.map(tab => tab.project))];
  const valid = new Set((await Promise.all(groups.map(async path => {
    try { return (await api.sessions(path)).map(s => s.id); } catch { return []; }
  }))).flat());
  for (const tab of prefs.tabs) {
    if (valid.has(tab.id)) await open(tab);
  }
  if (tabs.has(prefs.active)) setActive(prefs.active);
  else if (prior) {
    project = prior;
    setActive([...tabs.values()].reverse().find(tab => tab.session.project === prior)?.session.id ?? "");
    await refreshSessions(prior);
  }
  warnMissing();
}

function applyEvent(tab: Tab, event: EngineEvent) {
  const data = event.data ?? {};
  switch (event.type) {
    case "run_started":
      if (tab.sending) {
        const { text } = tab.sending;
        add(tab, { role: "user", text });
        if (tab.draft === text) {
          tab.draft = "";
          if (active === tab.session.id) prompt.value = "";
        }
        tab.sending = undefined;
      }
      tab.children.clear();
      tab.runContext = { agent: data.agent, agent_mode: data.agent_mode };
      tab.status = "Running";
      break;
    case "files_attached": {
      const message = [...tab.entries].reverse().find(entry => entry.role === "user");
      if (message && data.paths?.length) message.files = data.paths;
      break;
    }
    case "assistant_started": tab.partial = ""; tab.toolProgress = undefined; break;
    case "assistant_updated": tab.partial = limit(tab.partial + (data.text ?? ""), 32768); break;
    case "assistant_reset": tab.partial = ""; break;
    case "assistant_completed": {
      const content = typeof data.message === "object" ? data.message.content : tab.partial;
      if (content) add(tab, { role: "assistant", text: content });
      tab.partial = "";
      break;
    }
    case "tool_progress": tab.toolProgress = [data.tool, data.target].filter(Boolean).join(" · "); break;
    case "tool_started":
      if (data.id && data.name) {
        tab.toolNames.set(data.id, data.name);
        if (tab.toolNames.size > 200) tab.toolNames.delete(tab.toolNames.keys().next().value!);
      }
      tab.toolProgress = data.name;
      break;
    case "tool_updated":
    case "tool_finished":
      if (data.result?.content) add(tab, { role: "tool", label: tab.toolNames.get(data.id ?? "") ?? "Tool output", text: data.result.content });
      tab.toolProgress = undefined;
      break;
    case "permission_resolved": tab.input = undefined; break;
    case "subagent_started":
    case "subagent_event":
    case "subagent_finished": {
      const key = data.task_id ?? data.id;
      if (!key) break;
      const child = tab.children.get(key) ?? { agent: data.agent ?? "Child agent", status: "Running" };
      if (event.type === "subagent_finished") child.status = data.status ?? "Finished";
      else if (data.event?.type === "tool_started") child.status = data.event.data?.name ?? "Using tool";
      else if (data.event?.type === "assistant_started") child.status = "Working";
      tab.children.set(key, child);
      if (tab.children.size > 30) tab.children.delete(tab.children.keys().next().value!);
      break;
    }
    case "error": if (typeof data.message === "string") tab.error = limit(data.message); break;
    case "run_finished":
      if (!data.run_id || !tab.runs.some(run => run.run_id === data.run_id)) {
        tab.runs.push({ ...data, agent: data.agent ?? tab.runContext?.agent,
          agent_mode: data.agent_mode ?? tab.runContext?.agent_mode, time: Date.now() });
        if (tab.runs.length > 12) tab.runs.shift();
      }
      tab.status = runLabel(data);
      if (tab.session.id === active && runDialog.open) drawRunHistory(tab);
      tab.input = undefined;
      break;
  }
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; drawNavigation(); drawSession(); });
}

onFrames((id, frames) => {
  const tab = tabs.get(id);
  if (!tab) return;
  for (const frame of frames) {
    if (frame.event) applyEvent(tab, frame.event);
    if (frame.input) tab.input = frame.input;
    if (frame.end) {
      tab.running = false;
      tab.input = undefined;
      tab.toolProgress = undefined;
      if (frame.error) { tab.error = frame.error; tab.status = frame.error === "Cancelled" ? "Cancelled" : "Stopped"; }
      tab.recovery = frame.pending ?? tab.sending?.recovery;
      tab.sending = undefined;
    }
  }
  if (id === active || frames.some((frame: Frame) => frame.input || frame.end)) queueRender();
});

function drawSession() {
  const tab = tabs.get(active);
  get("empty").hidden = !!tab;
  get("session").hidden = !tab;
  if (!tab) {
    get("welcome-title").textContent = project ? nameOf(project) : "Open a project";
    get("welcome-copy").textContent = project || "Choose a repository or folder to start an agent session or open a terminal.";
    get("empty-pick").hidden = !!project;
    get("welcome-session").hidden = !project;
    get("welcome-terminal").hidden = !project;
    return;
  }
  get("starter-prompt").hidden = tab.loading || tab.running || !!tab.input || !!tab.recovery || tab.entries.length > 0 || !!tab.draft;
  const switching = previousTab !== active;
  previousTab = active;
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
  get("session-project").textContent = nameOf(tab.session.project);
  get("session-name").textContent = sessionLabel(tab.session);
  get("session-path").textContent = tab.session.project;
  get("session-path").title = tab.session.project;
  get("run-status").dataset.state = tab.input ? "input" : tab.running ? "active" : "idle";
  get("run-status").textContent = tab.input ? "Needs input" : tab.toolProgress ? limit(tab.toolProgress, 45) : tab.status;
  get<HTMLButtonElement>("attach-files").disabled = tab.loading || !!tab.recovery;
  agentMode.value = tab.mode;
  agentMode.disabled = tab.running || tab.loading || !!tab.recovery;
  agentMode.title = get("mode-description").textContent = modeHelp[tab.mode];
  get<HTMLButtonElement>("run-details").disabled = tab.loading;
  get<HTMLButtonElement>("session-export").disabled = tab.running || tab.loading;
  get<HTMLButtonElement>("send").disabled = tab.running || tab.loading || !!tab.recovery;
  get("cancel").hidden = !tab.running;
  if (switching) transcript.replaceChildren();
  if (!tab.entries.length && !tab.partial) {
    get("messages").dataset.empty = tab.loading ? "Loading conversation…" : "Start the conversation with a message.";
  } else delete get("messages").dataset.empty;
  const entries = tab.partial ? [...tab.entries, { role: "assistant", text: tab.partial }] : tab.entries;
  // Keep existing nodes and update only entries that changed.
  for (const [index, e] of entries.entries()) {
    const current = transcript.children[index] as HTMLElement | undefined;
    const label = e.label ?? (e.role === "user" ? "You" : e.role === "assistant" ? "GoHarness" : e.role === "tool" ? "Tool output" : "");
    const files = JSON.stringify(e.files ?? []);
    if (current?.dataset.role === e.role && current.dataset.label === label &&
        current.dataset.content === e.text && current.dataset.files === files) continue;
    const row = element("article", "", "message " + e.role);
    row.dataset.role = e.role;
    row.dataset.label = label;
    row.dataset.content = e.text;
    row.dataset.files = files;
    if (e.role === "tool") {
      const details = element("details");
      details.append(element("summary", label),element("pre",e.text));
      row.append(details);
    } else {
      if (label) row.append(element("small", label));
      row.append(element("div", e.text, "message-text"));
      if (e.files?.length) {
        const attachments = element("ul", "", "message-attachments");
        attachments.setAttribute("aria-label", "Attached project files");
        for (const path of e.files) {
          const file = element("li");
          file.append(icon("attach"), element("span", path));
          attachments.append(file);
        }
        row.append(attachments);
      }
    }
    if (current) current.replaceWith(row); else transcript.append(row);
  }
  while (transcript.children.length > entries.length) transcript.lastElementChild!.remove();
  if (nearBottom || switching) transcript.scrollTop = transcript.scrollHeight;
  const agents = [...tab.children.entries()].map(([id, child]) => {
    const row = element("div", "", "agent");
    row.title = id;
    row.append(element("strong", child.agent), element("span", child.status, "muted"));
    return row;
  });
  get("agents").replaceChildren(...(agents.length ? agents : [element("p", "No child agents in this session.", "muted")]));
  if (tab.error) announce(tab.error);
  drawInput(tab);
}

function drawInput(tab: Tab) {
  const pane = get("challenge");
  const input = tab.input;
  const key = input?.id ?? (tab.recovery ? "recovery:" + tab.session.id : "");
  if (inputKey === key && !pane.hidden) return;
  inputKey = key;
  pane.replaceChildren();
  pane.hidden = !key;
  if (tab.recovery) {
    pane.append(element("h3", "Review uncertain effects"),
      element("p", "Inspect the project for changes from the interrupted tools before retrying. You can edit the message below."),
      element("pre", limit(JSON.stringify(tab.recovery, null, 2))),
      button("Acknowledge and retry", action(() => send(tab, tab.draft, true)), "primary"));
    return;
  }
  if (!input) return;
  let submitting = false;
  const answer = (reply: Reply) => action(async () => {
    if (submitting) return;
    submitting = true;
    try {
      await api.answer(tab.session, input.id, reply);
      if (tab.input?.id === input.id) tab.input = undefined;
      announce();
      queueRender();
    } finally { submitting = false; }
  })();
  if (input.kind === "permission") {
    const tool = input.data.tool ?? "Tool";
    if (tool === "plan_exit") {
      pane.append(element("h3", "Review proposed plan"),
        element("p", "To implement this plan, finish the current run, select Build, and send a follow-up.", "challenge-context"),
        element("pre", (input.data.preview ?? "").replace(/^Switch to Build mode and carry out this plan\?\s*/, "")),
        button("Continue in Plan", () => answer({ allow: false }), "primary"));
      return;
    }
    const edit = /(?:^|:)(?:write_file|edit_file|create_file|apply_patch)$/.test(tool);
    pane.append(element("h3", edit ? "Review proposed edit" : "Review requested action"),
      element("p", tool + " · " + nameOf(tab.session.project), "challenge-context"),
      element("pre", input.data.preview || "No additional details were provided by the engine."));
    const actions = element("div", "", "button-row");
    actions.append(button("Allow once", () => answer({ allow: true }), "primary"), button("Deny", () => answer({ allow: false })));
    pane.append(actions);
  } else if (input.kind === "question") {
    pane.append(element("h3", "GoHarness has a question"));
    const questions = input.data.questions ?? [];
    const groups = questions.map((question, index) => {
      const group = element("fieldset");
      group.append(element("legend", question.question));
      for (const option of question.options) {
        const choice = element("input");
        choice.type = question.multiple ? "checkbox" : "radio";
        choice.name = "question-" + index;
        choice.value = option.label;
        const label = element("label");
        label.append(choice, document.createTextNode(option.label + (option.description ? " · " + option.description : "")));
        group.append(label);
      }
      const custom = element("input");
      custom.placeholder = "Other answer";
      custom.setAttribute("aria-label", question.question + " – other answer");
      group.append(custom);
      pane.append(group);
      return { group, custom, multiple: question.multiple };
    });
    const actions = element("div", "", "button-row");
    const error = element("p", "", "challenge-context");
    error.setAttribute("role", "alert");
    actions.append(button("Submit answers", () => {
      const answers = groups.map(({ group, custom, multiple }) => {
        const chosen = [...group.querySelectorAll<HTMLInputElement>("input:checked")].map(choice => choice.value);
        if (!custom.value.trim()) return chosen;
        return multiple ? [...chosen, custom.value.trim()] : [custom.value.trim()];
      });
      const missing = answers.findIndex(group => !group.length);
      if (missing !== -1) {
        error.textContent = "Choose or enter an answer for each question.";
        groups[missing].group.querySelector("input")?.focus();
        return;
      }
      error.textContent = "";
      answer({ answers });
    }, "primary"), button("Dismiss", () => answer({ dismiss: true })));
    pane.append(error);
    pane.append(actions);
  }
}

async function send(tab: Tab, text: string, acknowledge = false) {
  if (tab.running || tab.loading || (tab.recovery && !acknowledge)) return;
  if (!text.trim()) {
    if (acknowledge) {
      announce("Enter a message to continue after reviewing uncertain effects.");
      prompt.focus();
    }
    return;
  }
  tab.status = "Starting";
  tab.running = true;
  tab.error = undefined;
  tab.sending = { text, recovery: tab.recovery };
  tab.recovery = undefined;
  announce();
  queueRender();
  try {
    await api.start(tab.session, text, acknowledge, tab.mode);
  } catch (err) {
    tab.running = false;
    tab.status = "Ready";
    tab.error = errorText(err);
    tab.recovery = tab.sending?.recovery;
    tab.sending = undefined;
    queueRender();
  }
}

const pick = action(async () => choose(await api.pick()));
get("pick").onclick = pick;
get("empty-pick").onclick = pick;
async function createSession(path: string) {
  if (creatingSession) return;
  if (tabs.size >= 30) throw new Error("Close a session tab before creating another.");
  creatingSession = true;
  try {
    const session = await api.create(path);
    await open(session);
    await refreshSessions(path);
    prompt.focus();
  } finally {
    creatingSession = false;
  }
}

const newSession = action(async () => {
  if (!project) await pick();
  const chosen = project;
  if (!chosen || creatingSession) return;
  if (!hasProvider && !(await refreshProvider()).model) {
    pendingSessionProject = chosen;
    await showProvider();
    return;
  }
  await createSession(chosen);
});
for (const id of ["create","tab-new","welcome-session"]) get(id).onclick = newSession;
get<HTMLInputElement>("project-filter").oninput = event => {
  filter = (event.target as HTMLInputElement).value.trim().toLocaleLowerCase();
  drawNavigation();
};
get<HTMLFormElement>("composer").onsubmit = event => {
  event.preventDefault();
  const tab = tabs.get(active);
  if (tab) void send(tab, prompt.value);
};
function insertReferences(session: Session, refs: string[]) {
  const tab = tabs.get(session.id);
  if (!tab || !refs.length) return;
  const text = tab.draft;
  const focused = active === session.id;
  const cursor = focused ? prompt.selectionEnd : text.length;
  const left = text.slice(0, cursor);
  const right = text.slice(cursor);
  const start = left && !/\s$/.test(left) ? " " : "";
  const insertion = start + refs.join(" ") + (right && /^\s/.test(right) ? "" : " ");
  tab.draft = left + insertion + right;
  if (focused) {
    prompt.value = tab.draft;
    prompt.setSelectionRange(cursor + insertion.length, cursor + insertion.length);
    drawSession();
    prompt.focus();
  }
}

const attachFiles = action(async () => {
  const tab = tabs.get(active);
  if (!tab || tab.loading || tab.recovery) return;
  const refs = await api.pickContextFiles(tab.session);
  if (refs?.length) insertReferences(tab.session, refs);
});
get("attach-files").onclick = attachFiles;

agentMode.onchange = () => {
  const tab = tabs.get(active);
  if (!tab || agentMode.disabled) return;
  tab.mode = agentMode.value as RunMode;
  if (tab.mode === "default") delete prefs.modes[tab.session.id];
  else prefs.modes[tab.session.id] = tab.mode;
  persist();
  drawSession();
};
prompt.oninput = () => {
  const tab = tabs.get(active);
  if (tab) tab.draft = prompt.value;
  if (tab && !tab.entries.length) {
    get("starter-prompt").hidden = tab.loading || tab.running || !!tab.input || !!tab.recovery || !!tab.draft;
  }
};
get("starter-prompt").onclick = () => {
  const tab = tabs.get(active);
  if (!tab || tab.draft) return;
  prompt.value = tab.draft = "Inspect this project and summarize how to build and test it. Do not modify any files.";
  drawSession();
  prompt.focus();
};
prompt.onkeydown = event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    get<HTMLFormElement>("composer").requestSubmit();
  }
};
get("cancel").onclick = action(async () => { const tab = tabs.get(active); if (tab) await api.cancel(tab.session); });

const providerDialog = get<HTMLDialogElement>("provider-dialog");
const providerMessage = (message: string) => { get("provider-status").textContent = message; };
const refreshProvider = async () => {
  const p = await api.provider();
  hasProvider = !!p.model;
  get("provider-chip").textContent = p.model || "Connect provider";
  get("provider").dataset.connected = String(!!p.model);
  providerMessage(p.model ? [p.source, p.model, p.protocol].filter(Boolean).join(" · ") :
    "Connect ChatGPT or enter an API endpoint and model. Local servers may use a blank key.");
  return p;
};
const showProvider = async () => {
  const banner = get("provider-intent");
  banner.hidden = !pendingSessionProject;
  banner.textContent = pendingSessionProject ? "Connect a provider to start a session in " + nameOf(pendingSessionProject) + "." : "";
  if (!providerDialog.open) providerDialog.showModal();
  await refreshProvider();
};
get("provider").onclick = action(showProvider, providerMessage);
get("close-provider").onclick = () => { pendingSessionProject = ""; providerDialog.close(); };
providerDialog.addEventListener("cancel", () => { pendingSessionProject = ""; });

async function resumeAfterProvider() {
  const state = await refreshProvider();
  const chosen = pendingSessionProject;
  if (!chosen || !state.model || !providerDialog.open) return false;
  await createSession(chosen);
  pendingSessionProject = "";
  providerDialog.close();
  prompt.focus();
  return true;
}
get<HTMLFormElement>("provider-form").onsubmit = event => {
  event.preventDefault();
  const input = (id: string) => get<HTMLInputElement>(id);
  void action(async () => {
    const save = get<HTMLButtonElement>("save-provider");
    if (save.disabled) return;
    save.disabled = true;
    try {
      await api.saveProvider({ protocol: input("protocol").value, base_url: input("endpoint").value, model: input("model").value, context_window: Number(input("window").value), key: input("api-key").value });
      input("api-key").value = "";
      if (!await resumeAfterProvider()) providerMessage("Provider saved. Send a message to check the connection.");
    } finally {
      save.disabled = false;
    }
  }, providerMessage)();
};
get("engine-settings").onclick = action(async () => { await api.saveProvider({ protocol: "" }); await resumeAfterProvider(); }, providerMessage);
function login(switchAccount: boolean) {
  return action(async () => {
    get("cancel-login").hidden = false;
    providerMessage("Complete sign-in in your default browser, then return here.");
    try { await api.login(switchAccount); await resumeAfterProvider(); }
    finally {
      get("cancel-login").hidden = true;
      get("auth-label").hidden = true;
      get<HTMLInputElement>("auth-url").value = "";
    }
  }, providerMessage);
}
get("login").onclick = login(false);
get("switch").onclick = login(true);
get("cancel-login").onclick = action(() => api.cancelLogin(), providerMessage);
onAuthURL(url => {
  get<HTMLInputElement>("auth-url").value = url;
  get("auth-label").hidden = false;
});

const updateDialog = get<HTMLDialogElement>("update-dialog");
const updateMessage = (message: string) => { get("update-status").textContent = message; };
const stage = get<HTMLButtonElement>("stage-update");
const restart = get<HTMLButtonElement>("apply-update");
get("updates").onclick = action(async () => {
  updateDialog.showModal();
  const status = await api.updateStatus();
  if (status) updateMessage(status);
  stage.hidden = !!status;
}, updateMessage);
get("close-update").onclick = () => updateDialog.close();
stage.onclick = action(async () => {
  stage.disabled = true;
  restart.hidden = true;
  updateMessage("Checking and verifying the desktop package…");
  try {
    const next = await api.stageUpdate();
    updateMessage(next ? "Version " + next + " is ready. Restart when your sessions are idle." : "You’re on the latest version.");
    restart.hidden = !next;
  } finally { stage.disabled = false; }
}, updateMessage);
restart.onclick = action(() => api.applyUpdate(), updateMessage);

function terminalPanel() {
  terminalLoading ??= import("./terminals").then(({ TerminalDock }) => {
    terminalDock = new TerminalDock(get("terminal-dock"), get("terminal-tabs"), get("terminal-panes"), (opened, count, split) => {
      get("dock-toggle").setAttribute("aria-pressed",String(opened));
      get("terminal-split").setAttribute("aria-pressed",String(split));
      get("terminal-count").textContent = count ? "Terminal · " + count : "Terminal";
      get<HTMLButtonElement>("terminal-find").disabled = count === 0;
      get<HTMLButtonElement>("terminal-rename").disabled = count === 0;
    }, error => announce(errorText(error)));
    terminalDock.configure(prefs.theme,prefs.font_size);
    return terminalDock;
  }).catch(error => { terminalLoading = undefined; throw error; });
  return terminalLoading;
}

function openProjectTerminal(path: string) {
  return action(async () => (await terminalPanel()).add(path,prefs.shell));
}

const openTerminal = action(async () => {
  if (!project) await pick();
  if (project) await (await terminalPanel()).add(project,prefs.shell);
});
const toggleTerminal = action(async () => (await terminalPanel()).toggle());
for (const id of ["terminal-add","welcome-terminal"]) get(id).onclick = openTerminal;
for (const id of ["dock-toggle","status-terminal"]) get(id).onclick = toggleTerminal;
get("terminal-hide").onclick = () => terminalDock?.show(false);
get("terminal-split").onclick = action(async () => {
  if (!project) await pick();
  if (project) await (await terminalPanel()).split(project,prefs.shell);
});

function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.density = prefs.density;
  get("workspace").classList.toggle("sidebar-hidden",!prefs.sidebar);
  get("activity").hidden = !prefs.activity;
  get("session-body").classList.toggle("activity-hidden",!prefs.activity);
  get("sidebar-toggle").setAttribute("aria-pressed",String(prefs.sidebar));
  get("activity-toggle").setAttribute("aria-pressed",String(prefs.activity));
  get("terminal-dock").style.setProperty("--terminal-height",prefs.terminal_size + "%");
  get("dock-resize").setAttribute("aria-valuenow",String(prefs.terminal_size));
  get<HTMLSelectElement>("theme").value = prefs.theme;
  get<HTMLSelectElement>("density").value = prefs.density;
  get<HTMLInputElement>("terminal-font").value = String(prefs.font_size);
  get<HTMLSelectElement>("shell").value = prefs.shell;
  get<HTMLInputElement>("restore").checked = prefs.restore;
  get<HTMLInputElement>("show-projects").checked = prefs.sidebar;
  get<HTMLInputElement>("show-activity").checked = prefs.activity;
  terminalDock?.configure(prefs.theme,prefs.font_size);
}

function changePrefs(patch: Partial<Workspace>) {
  prefs = {...prefs,...patch};
  applyPrefs();
  persist();
}

const resize = get("dock-resize");
const resizeDock = (value: number, save: boolean) => {
  prefs.terminal_size = Math.round(Math.max(18, Math.min(62,value)));
  get("terminal-dock").style.setProperty("--terminal-height",prefs.terminal_size + "%");
  resize.setAttribute("aria-valuenow",String(prefs.terminal_size));
  if (save) persist();
};
resize.onpointerdown = event => {
  if (event.button !== 0) return;
  event.preventDefault();
  resize.setPointerCapture(event.pointerId);
};
resize.onpointermove = event => {
  if (!resize.hasPointerCapture(event.pointerId)) return;
  const bounds = get("terminal-dock").parentElement!.getBoundingClientRect();
  resizeDock((bounds.bottom - event.clientY) / bounds.height * 100,false);
};
resize.onlostpointercapture = persist;
resize.onkeydown = event => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  resizeDock(prefs.terminal_size + (event.key === "ArrowUp" ? 3 : -3),true);
};
const sidebar = () => changePrefs({sidebar:!prefs.sidebar});
const activity = () => changePrefs({activity:!prefs.activity});
get("sidebar-toggle").onclick = sidebar;
get("activity-toggle").onclick = activity;
const settings = get<HTMLDialogElement>("settings-dialog");
const showSettings = () => { if (!settings.open) settings.showModal(); };
get("settings").onclick = showSettings;
get("close-settings").onclick = () => settings.close();
get("settings-provider").onclick = () => { settings.close(); get("provider").click(); };
get("reset-settings").onclick = () => changePrefs({
  theme:defaults.theme, density:defaults.density, font_size:defaults.font_size,
  terminal_size:defaults.terminal_size, sidebar:true, activity:true,
});
get<HTMLSelectElement>("theme").onchange = event => changePrefs({theme:(event.target as HTMLSelectElement).value});
get<HTMLSelectElement>("density").onchange = event => changePrefs({density:(event.target as HTMLSelectElement).value});
get<HTMLInputElement>("terminal-font").onchange = event => {
  const number = Number((event.target as HTMLInputElement).value);
  changePrefs({font_size:Number.isFinite(number) ? Math.round(Math.min(22,Math.max(11,number))) : 13});
};
get<HTMLSelectElement>("shell").onchange = event => changePrefs({shell:(event.target as HTMLSelectElement).value});
get<HTMLInputElement>("restore").onchange = event => changePrefs({restore:(event.target as HTMLInputElement).checked});
get<HTMLInputElement>("show-projects").onchange = sidebar;
get<HTMLInputElement>("show-activity").onchange = activity;

const rename = get<HTMLDialogElement>("rename-dialog");
const nameInput = get<HTMLInputElement>("rename-value");
const renameSession = () => {
  const tab = tabs.get(active);
  if (!tab) return;
  nameInput.value = sessionLabel(tab.session);
  rename.showModal();
  nameInput.select();
};
get("rename-session").onclick = renameSession;
get("rename-cancel").onclick = () => rename.close();
get<HTMLFormElement>("rename-form").onsubmit = event => {
  event.preventDefault();
  if (!active || !nameInput.value.trim()) return;
  prefs.names = {...prefs.names,[active]:nameInput.value.trim()};
  rename.close();
  drawNavigation();
  drawSession();
  persist();
};

const runDialog = get<HTMLDialogElement>("run-dialog");
const formatRunValue = (label: string) => label.replaceAll("_", " ").replace(/^./, char => char.toUpperCase());

function runLabel(run: RunSummary) {
  switch (run.outcome) {
    case "verified": return "Verified";
    case "unverified": return "Changes unverified";
    case "no_changes": return "No changes";
    case "failed_verification": return "Verification failed";
    default: return run.status ? formatRunValue(run.status) : "Finished";
  }
}

function drawRunHistory(tab: Tab) {
  get("run-context").textContent = sessionLabel(tab.session) + " · " + nameOf(tab.session.project);
  const rows = [...tab.runs].reverse().map(run => {
    const row = element("article", "", "run-record");
    row.append(element("h3", runLabel(run)));
    const timestamp = run.time ? new Date(run.time).toLocaleString() : "";
    const duration = run.duration_ms === undefined ? "" : (run.duration_ms / 1000).toFixed(1) + " s";
    const meta = [run.agent, run.agent_mode && run.agent_mode !== run.agent ? run.agent_mode : "", run.status && formatRunValue(run.status), timestamp, duration];
    row.append(element("p", meta.filter(Boolean).join(" · "), "muted"));
    if (run.verification_detail?.change_tracking === "unknown") {
      row.append(element("p", "GoHarness could not track all project changes.", "muted"));
    }
    const evidence = run.verification_detail?.evidence;
    if (evidence) {
      const check = evidence.passed === undefined ? "Check recorded" : evidence.passed ? "Check passed" : "Check failed";
      const exit = evidence.exit_code === undefined ? "" : "Exit code " + evidence.exit_code;
      row.append(element("p", [check, evidence.source, evidence.kind, evidence.scope, exit].filter(Boolean).join(" · ")));
      if (evidence.command) row.append(element("pre", evidence.command));
      if (evidence.revision) row.append(element("p", "Revision " + evidence.revision, "muted"));
    }
    return row;
  });
  get("run-list").replaceChildren(...(rows.length ? rows : [element("p", "No completed runs yet.", "muted")]));
}

function showRunHistory() {
  const tab = tabs.get(active);
  if (!tab || tab.loading) return;
  drawRunHistory(tab);
  if (!runDialog.open) runDialog.showModal();
}
get("run-details").onclick = showRunHistory;
get("close-runs").onclick = () => runDialog.close();

const exportDialog = get<HTMLDialogElement>("export-dialog");
const exportFormat = get<HTMLSelectElement>("export-format");
const exportTools = get<HTMLInputElement>("export-tools");
const exportConfirm = get<HTMLButtonElement>("export-confirm");
let exporting: Session | undefined;

function updateExportOptions() {
  const markdown = exportFormat.value === "markdown";
  get("export-tools-option").hidden = !markdown;
  get("export-format-help").textContent = markdown
    ? "A readable copy of the conversation."
    : "Includes tool records for importing into GoHarness.";
}

function showExport() {
  const tab = tabs.get(active);
  if (!tab || tab.running || tab.loading || exportConfirm.disabled) return;
  exporting = tab.session;
  get("export-context").textContent = sessionLabel(tab.session) + " · " + nameOf(tab.session.project);
  get("export-error").hidden = true;
  updateExportOptions();
  if (!exportDialog.open) exportDialog.showModal();
}
get("session-export").onclick = showExport;
get("close-export").onclick = () => { if (!exportConfirm.disabled) exportDialog.close(); };
exportDialog.oncancel = event => { if (exportConfirm.disabled) event.preventDefault(); };
exportFormat.onchange = updateExportOptions;
get<HTMLFormElement>("export-form").onsubmit = event => {
  event.preventDefault();
  if (!exporting || exportConfirm.disabled) return;
  const session = exporting;
  const format = exportFormat.value as ExportFormat;
  const includeTools = format === "markdown" && exportTools.checked;
  const error = get("export-error");
  error.hidden = true;
  exportConfirm.disabled = true;
  void action(async () => {
    try {
      const path = await api.exportSession(session, format, includeTools);
      if (path) {
        exportDialog.close();
        announce("Session exported to " + path);
      }
    } finally {
      exportConfirm.disabled = false;
    }
  }, message => { error.textContent = message; error.hidden = false; })();
};

const attentionDialog = get<HTMLDialogElement>("attention-dialog");
const attentionList = get("attention-list");

function waitingTabs() {
  return [...tabs.values()].filter(tab => tab.input || tab.recovery);
}

function showAttention() {
  if (!attentionDialog.open) attentionDialog.showModal();
  drawAttention();
  attentionList.querySelector("button")?.focus();
}

function drawAttention() {
  const waiting = waitingTabs();
  const control = get("attention");
  control.hidden = !waiting.length;
  const summary = waiting.length === 1 ? "1 session needs input" : waiting.length + " sessions need input";
  const live = get("attention-live");
  if (live.textContent !== summary) live.textContent = summary;
  control.setAttribute("aria-label", summary);
  get("attention-count").textContent = "Needs input · " + waiting.length;
  if (!attentionDialog.open) return;
  const focused = (document.activeElement as HTMLElement | null)?.dataset.session;
  const rows = waiting.map(tab => {
    const reason = tab.recovery ? "Recovery review" : tab.input?.kind === "question" ? "Question" : tab.input?.data.tool === "plan_exit" ? "Plan review" : "Approval";
    const row = button("", () => {
      attentionDialog.close();
      setActive(tab.session.id);
      get("challenge").focus();
    },"attention-row");
    row.dataset.session = tab.session.id;
    row.title = tab.session.project;
    const names = element("span","","attention-label");
    names.append(element("strong",sessionLabel(tab.session)),element("small",tab.session.project));
    row.append(icon("alert"),names,element("span",reason,"attention-kind"));
    return row;
  });
  attentionList.replaceChildren(...(rows.length ? rows : [element("p","No pending approvals or questions.","muted")]));
  if (focused) (rows.find(row => row.dataset.session === focused) ?? get("close-attention")).focus();
}

get("attention").onclick = showAttention;
get("close-attention").onclick = () => attentionDialog.close();

type Command = { label: string; detail?: string; glyph: string; run: () => void };
const palette = get<HTMLDialogElement>("palette-dialog");
const query = get<HTMLInputElement>("palette-query");
let selectedCommand = 0;
let commands: Command[] = [];
const shortcuts = mac ? { palette:"⌘ K", open:"⌘ O", terminal:"⌘ ⇧ T", settings:"⌘ ," } :
  {palette:"Ctrl K", open:"Ctrl O", terminal:"Ctrl Shift T", settings:"Ctrl ,"};
const forget = action(async () => {
  const path = project;
  if (!path) return;
  await api.forgetProject(path);
  prefs.pins = prefs.pins.filter(p => p !== path);
  projects = await api.projects();
  project = "";
  sessions = [];
  setActive("");
});

function getCommands(): Command[] {
  const candidates: Command[] = [
    {label:"Open project folder…", detail:shortcuts.open, glyph:"folder", run:pick},
    {label:"New session", glyph:"session", run:newSession},
    {label:"New terminal", detail:shortcuts.terminal, glyph:"terminal", run:openTerminal},
    {label:"Toggle terminal panel", glyph:"terminal", run:toggleTerminal},
    {label:"Toggle projects sidebar", glyph:"sidebar", run:sidebar},
    {label:"Toggle agent activity", glyph:"activity", run:activity},
    {label:"Workspace settings", detail:shortcuts.settings, glyph:"settings", run:showSettings},
    {label:"Provider settings", glyph:"settings", run:() => get("provider").click()},
    {label:"Check for updates", glyph:"arrow", run:() => get("updates").click()},
  ];
  if (waitingTabs().length) candidates.push({label:"Review sessions needing input",glyph:"alert",run:showAttention});
  if (tabs.has(active)) {
    candidates.push({label:"Attach project files…",glyph:"attach",run:attachFiles});
    candidates.push({label:"View run history",glyph:"history",run:showRunHistory});
    if (!get<HTMLButtonElement>("session-export").disabled) {
      candidates.push({label:"Export current session…",glyph:"download",run:showExport});
    }
    candidates.push({label:"Rename current session",glyph:"edit",run:renameSession});
    candidates.push({label:"Close current session tab",glyph:"close",run:() => closeTab(tabs.get(active)!)});
  }
  if (project) {
    candidates.push({label:prefs.pins.includes(project) ? "Unpin current project" : "Pin current project",glyph:"pin",run:() => togglePin(project)});
    candidates.push({label:"Remove current project from recents",glyph:"close",run:forget});
  }
  if (terminalDock?.entries().length) {
    candidates.push({label:"Find in active terminal",glyph:"search",run:() => terminalDock?.find()});
    candidates.push({label:"Rename active terminal",glyph:"edit",run:() => terminalDock?.rename()});
    for (const terminal of terminalDock.entries()) {
      candidates.push({label:"Switch to " + terminal.title, detail:terminal.project + (terminal.ended ? " · Exited" : ""), glyph:"terminal",run:() => terminalDock?.select(terminal.id)});
    }
    candidates.push({label:"Copy terminal selection",glyph:"terminal",run:action(() => terminalDock!.copy())});
    candidates.push({label:"Paste into active terminal",glyph:"terminal",run:action(() => terminalDock!.paste())});
    candidates.push({label:"Clear terminal scrollback",glyph:"terminal",run:() => terminalDock?.clear()});
  }
  for (const path of projectPaths()) {
    candidates.push({label:"Open " + nameOf(path), detail:path, glyph:"folder",run:() => {void openProject(path);}});
    candidates.push({label:"Open terminal in " + nameOf(path), detail:path, glyph:"terminal",run:openProjectTerminal(path)});
  }
  for (const tab of tabs.values()) candidates.push({label:sessionLabel(tab.session),detail:nameOf(tab.session.project),glyph:"session",run:() => setActive(tab.session.id)});
  return candidates;
}

function drawPalette() {
  const words = query.value.trim().toLocaleLowerCase().split(/\s+/);
  commands = getCommands().filter(cmd => words.every(word => (cmd.label + " " + (cmd.detail ?? "")).toLocaleLowerCase().includes(word))).slice(0,40);
  selectedCommand = Math.min(selectedCommand,Math.max(0,commands.length - 1));
  const rows = commands.map((command,index) => {
    const row = button("", () => { palette.close(); command.run(); }, "palette-result");
    row.id = "command-" + index;
    row.setAttribute("role","option");
    row.setAttribute("aria-selected",String(index === selectedCommand));
    row.append(icon(command.glyph),element("span",command.label),element("small",command.detail ?? ""));
    return row;
  });
  get("palette-results").replaceChildren(...(rows.length ? rows : [element("p","No matching commands","sidebar-empty")]));
  if (rows.length) query.setAttribute("aria-activedescendant",rows[selectedCommand].id);
  else query.removeAttribute("aria-activedescendant");
  rows[selectedCommand]?.scrollIntoView({block:"nearest"});
}

function showPalette() {
  if (palette.open) { palette.close(); return; }
  query.value = "";
  selectedCommand = 0;
  palette.showModal();
  drawPalette();
  query.setAttribute("aria-expanded","true");
  query.focus();
}
palette.addEventListener("close", () => query.setAttribute("aria-expanded","false"));
get("palette").onclick = showPalette;
query.oninput = () => { selectedCommand = 0; drawPalette(); };
query.onkeydown = event => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    selectedCommand = Math.max(0,selectedCommand + (event.key === "ArrowDown" ? 1 : -1));
    drawPalette();
  } else if (event.key === "Enter" && commands[selectedCommand]) {
    event.preventDefault();
    palette.close();
    commands[selectedCommand].run();
  }
};

const nativeCommands: Record<string, () => void> = {
  settings:showSettings, open:pick, session:newSession, terminal:openTerminal, palette:showPalette,
  sidebar, dock:toggleTerminal, activity,
};
onCommand(command => nativeCommands[command]?.());
document.addEventListener("keydown", event => {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey || event.repeat || event.isComposing) return;
  const key = event.key.toLowerCase();
  const inTerminal = event.target instanceof HTMLElement && !!event.target.closest(".xterm");
  if (inTerminal && !mac && !event.shiftKey) return;
  const paletteKey = key === "k" || (key === "p" && event.shiftKey);
  if (document.querySelector("dialog[open]") && !(paletteKey && palette.open)) return;
  let command: (() => void) | undefined;
  if (paletteKey) command = showPalette;
  if (key === "o" && !event.shiftKey) command = pick;
  if (key === "t" && event.shiftKey) command = openTerminal;
  if (key === "f" && terminalDock && (inTerminal || event.target === get("terminal-query"))) command = () => terminalDock?.find();
  if (key === "," && !event.shiftKey) command = showSettings;
  if (!command) return;
  event.preventDefault();
  event.stopPropagation();
  command();
},true);

async function initializeWorkspace() {
  projects = await api.projects();
  const [stored, shells] = await Promise.allSettled([api.workspace(),api.shells()]);
  prefs = stored.status === "fulfilled" ? {...defaults,...stored.value} : {...defaults};
  const available = shells.status === "fulfilled" ? shells.value : [{id:"default",name:"Default shell"}];
  if (!available.some(shell => shell.id === prefs.shell)) prefs.shell = "default";
  get("shell").replaceChildren(...available.map(shell => {
    const option = element("option",shell.name);
    option.value = shell.id;
    return option;
  }));
  applyPrefs();
  await restoreWorkspace();
  ready = true;
  drawNavigation();
  drawSession();
  if (stored.status === "rejected") announce("Saved workspace preferences could not be read. Using defaults.");
}

async function showVersions() {
  const versions = await api.versions();
  get("versions").textContent = "Desktop " + versions.desktop + " · Engine " + versions.engine + (versions.channel === "preview" ? " · Preview" : "");
}

void action(async () => {
  const smoke = await api.smoke();
  if (smoke && (smoke.mode === "audit" || smoke.mode === "audit-reopen")) {
    const report = async (step: string, quit = false) => { await api.report(JSON.stringify({step}), quit); };
    try {
      await showVersions();
      await initializeWorkspace();
      if (smoke.mode === "audit-reopen") {
        if (!active || [...tabs.values()].some(tab => nameOf(tab.session.project) === "recovery project") ||
            !(get("alert").textContent ?? "").includes("folder is unavailable")) {
          throw new Error("missing project restore: active=" + active + " tabs=" + tabs.size + " alert=" + get("alert").textContent);
        }
        await report("audit-restored", true);
        return;
      }
      const { checkAudit } = await import("./audit");
      await checkAudit(smoke, choose, open, report, () => saved);
    } catch (err) {
      await api.report(JSON.stringify({step:"failed",error:errorText(err)}),true);
    }
    return;
  }
  if (smoke && (smoke.mode === "workspace" || smoke.mode === "workspace-reopen")) {
    try {
      await showVersions();
      await initializeWorkspace();
      if (smoke.mode === "workspace-reopen") {
        if (!active || get("session-name").textContent !== "Review project" || prefs.theme !== "graphite" || !get("terminal-dock").hidden) {
          throw new Error("the app did not restore the saved project, session, and theme");
        }
        get("run-details").click();
        const runText = get("run-list").textContent ?? "";
        if (agentMode.value !== "build" || !runText.includes("No changes") ||
            (!/Win/.test(navigator.platform) && (!runText.includes("Verified") || !runText.includes("test -f note.txt")))) {
          throw new Error("the app did not restore the engine run evidence and selected mode");
        }
        get("close-runs").click();
        const attached = get("messages").querySelector(".message-attachments");
        if (!attached?.textContent?.includes("context café.txt") || get("messages").textContent?.includes("CONTEXT_FIXTURE_SECRET_MARKER")) {
          throw new Error("restored history lost the attachment label or displayed its full contents");
        }
        await api.report(JSON.stringify({step:"workspace-restored",theme:prefs.theme,session:active}),true);
        return;
      }
      const { checkWorkspace } = await import("./workspace-check");
      const state = await checkWorkspace(smoke,choose,open,() => saved,insertReferences);
      await api.report(JSON.stringify({step:"workspace-passed",theme:state.theme,session:state.active}),true);
    } catch (err) {
      await api.report(JSON.stringify({step:"failed",error:errorText(err)}),true);
    }
    return;
  }
  if (smoke) {
    await showVersions();
    await runSmoke(smoke, name => { get("versions").textContent = name; });
    return;
  }
  await initializeWorkspace();
  await Promise.all([
    showVersions().catch(error => { get("versions").textContent = "Engine unavailable"; announce(errorText(error)); }),
    refreshProvider().catch(error => providerMessage(errorText(error))),
  ]);
}, announce)();
