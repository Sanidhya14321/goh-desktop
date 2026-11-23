import { api, onAuthURL, onCommand, onFrames, type Challenge, type EngineEvent, type Frame, type Reply, type Session, type Workspace } from "./api";
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

type Entry = { role: string; text: string; label?: string };
type Child = { agent: string; status: string };
type Tab = {
  session: Session; entries: Entry[]; children: Map<string, Child>; toolNames: Map<string, string>;
  draft: string; partial: string; running: boolean; status: string; loading: boolean;
  input?: Challenge; error?: string; recovery?: unknown; lastPrompt?: string; toolProgress?: string;
};
const defaults: Workspace = {
  project: "", pins: [], tabs: [], active: "", names: {}, theme: "ember", density: "comfortable",
  font_size: 13, terminal_size: 32, shell: "default", sidebar: true, activity: true, restore: true,
};
let prefs: Workspace = {...defaults};
let ready = false;
let hasProvider = false;
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
    [...tabs.values()].map(tab => [tab.session.id, tab.running, !!tab.input])]);
  if (key === navigationKey) return;
  navigationKey = key;
  const paths = projectPaths().filter(path => path.toLocaleLowerCase().includes(filter));
  const projectItems = paths.map(path => {
    const row = element("div","","project-row" + (path === project ? " current" : ""));
    const title = element("span", nameOf(path), "item-title");
    const b = button("", () => { void openProject(path); }, "project");
    b.append(icon("folder"), title);
    b.title = path;
    b.setAttribute("aria-current", String(path === project));
    const pinned = prefs.pins.includes(path);
    const pin = iconButton(pinned ? "Unpin " + nameOf(path) : "Pin " + nameOf(path), "pin", () => togglePin(path), "pin-project");
    pin.setAttribute("aria-pressed",String(pinned));
    row.append(b,pin);
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
  const tab: Tab = { session, entries: [], children: new Map(), toolNames: new Map(), draft: "", partial: "", running: false, status: "Ready", loading: true };
  tabs.set(session.id, tab);
  setActive(session.id);
  try {
    const history = await api.history(session);
    if (history.truncated) add(tab, { role: "system", text: "Showing recent messages. The engine retains the full session journal." });
    for (const message of history.messages) add(tab, { role: message.role, text: message.content });
  } catch (error) {
    tab.error = errorText(error);
  } finally {
    tab.loading = false;
    if (active === session.id) drawSession();
  }
}

async function restoreWorkspace() {
  const prior = prefs.project;
  if (!prior) return;
  try {
    project = await api.select(prior);
    await refreshSessions(project);
  } catch (error) { announce(errorText(error)); return; }
  if (!prefs.restore) { drawNavigation(); drawSession(); return; }
  // Restore only session IDs still present in their project's journal list.
  const groups = [...new Set(prefs.tabs.map(tab => tab.project))];
  const valid = new Set((await Promise.all(groups.map(async path => {
    try { return (await api.sessions(path)).map(s => s.id); } catch { return []; }
  }))).flat());
  for (const tab of prefs.tabs) {
    if (valid.has(tab.id)) await open(tab);
  }
  if (tabs.has(prefs.active)) setActive(prefs.active);
  else {
    project = prior;
    setActive([...tabs.values()].reverse().find(tab => tab.session.project === prior)?.session.id ?? "");
    await refreshSessions(prior);
  }
}

function applyEvent(tab: Tab, event: EngineEvent) {
  const data = event.data ?? {};
  switch (event.type) {
    case "run_started": tab.status = "Running"; break;
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
      tab.status = [data.status, data.outcome?.replaceAll("_", " ")].filter(Boolean).join(" · ");
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
      if (frame.pending) tab.recovery = frame.pending;
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
  const switching = previousTab !== active;
  previousTab = active;
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
  get("session-project").textContent = nameOf(tab.session.project);
  get("session-name").textContent = sessionLabel(tab.session);
  get("session-path").textContent = tab.session.project;
  get("session-path").title = tab.session.project;
  get("run-status").dataset.state = tab.input ? "input" : tab.running ? "active" : "idle";
  get("run-status").textContent = tab.input ? "Needs input" : tab.toolProgress ? limit(tab.toolProgress, 45) : tab.status;
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
    if (current?.dataset.role === e.role && current.dataset.label === label && current.dataset.content === e.text) continue;
    const row = element("article", "", "message " + e.role);
    row.dataset.role = e.role;
    row.dataset.label = label;
    row.dataset.content = e.text;
    if (e.role === "tool") {
      const details = element("details");
      details.append(element("summary", label),element("pre",e.text));
      row.append(details);
    } else {
      if (label) row.append(element("small", label));
      row.append(element("div", e.text, "message-text"));
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
    pane.append(element("h3", "Review uncertain effects"), element("pre", limit(JSON.stringify(tab.recovery, null, 2))),
      button("Acknowledge and retry", action(() => send(tab, tab.lastPrompt ?? "", true)), "primary"));
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
    const edit = /(?:^|:)(?:write_file|edit_file|create_file|apply_patch)$/.test(tool);
    pane.append(element("h3", (edit ? "Proposed edit · " : "Approval required · ") + tool), element("pre", input.data.preview ?? ""));
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
    actions.append(button("Submit answers", () => answer({ answers: groups.map(({ group, custom, multiple }) => {
      const chosen = [...group.querySelectorAll<HTMLInputElement>("input:checked")].map(choice => choice.value);
      if (!custom.value.trim()) return chosen;
      return multiple ? [...chosen, custom.value.trim()] : [custom.value.trim()];
    }) }), "primary"), button("Dismiss", () => answer({ dismiss: true })));
    pane.append(actions);
  }
}

async function send(tab: Tab, text: string, acknowledge = false) {
  if (!text.trim() || tab.running || tab.loading || (tab.recovery && !acknowledge)) return;
  tab.status = "Starting";
  tab.running = true;
  tab.error = undefined;
  const recovery = tab.recovery;
  tab.recovery = undefined;
  tab.lastPrompt = text;
  tab.children.clear();
  announce();
  if (!acknowledge) add(tab, { role: "user", text });
  await Promise.resolve(api.start(tab.session, text, acknowledge)).then(() => {
    tab.draft = "";
    if (active === tab.session.id) prompt.value = "";
  }, error => {
    tab.running = false;
    tab.status = "Ready";
    tab.error = errorText(error);
    if (acknowledge) tab.recovery = recovery;
    if (!acknowledge && tab.entries.at(-1)?.role === "user") tab.entries.pop();
  });
  queueRender();
}

const pick = action(async () => choose(await api.pick()));
get("pick").onclick = pick;
get("empty-pick").onclick = pick;
const newSession = action(async () => {
  if (!project) { await pick(); return; }
  if (!hasProvider && !(await refreshProvider()).model) { get("provider").click(); return; }
  if (tabs.size >= 30) throw new Error("Close a session tab before creating another.");
  const chosen = project;
  const session = await api.create(chosen);
  await refreshSessions(chosen);
  await open(session);
  prompt.focus();
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
prompt.oninput = () => { const tab = tabs.get(active); if (tab) tab.draft = prompt.value; };
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
get("provider").onclick = action(async () => { providerDialog.showModal(); await refreshProvider(); }, providerMessage);
get("close-provider").onclick = () => providerDialog.close();
get<HTMLFormElement>("provider-form").onsubmit = event => {
  event.preventDefault();
  const input = (id: string) => get<HTMLInputElement>(id);
  void action(async () => {
    await api.saveProvider({ protocol: input("protocol").value, base_url: input("endpoint").value, model: input("model").value, context_window: Number(input("window").value), key: input("api-key").value });
    input("api-key").value = "";
    await refreshProvider();
    providerMessage("Provider saved. Open a project and send a message to check the connection.");
  }, providerMessage)();
};
get("engine-settings").onclick = action(async () => { await api.saveProvider({ protocol: "" }); await refreshProvider(); }, providerMessage);
function login(switchAccount: boolean) {
  return action(async () => {
    get("cancel-login").hidden = false;
    providerMessage("Complete sign-in in your default browser, then return here.");
    try { await api.login(switchAccount); await refreshProvider(); }
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
    }, error => announce(errorText(error)));
    terminalDock.configure(prefs.theme,prefs.font_size);
    return terminalDock;
  }).catch(error => { terminalLoading = undefined; throw error; });
  return terminalLoading;
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
  if (tabs.has(active)) {
    candidates.push({label:"Rename current session",glyph:"edit",run:renameSession});
    candidates.push({label:"Close current session tab",glyph:"close",run:() => closeTab(tabs.get(active)!)});
  }
  if (project) {
    candidates.push({label:prefs.pins.includes(project) ? "Unpin current project" : "Pin current project",glyph:"pin",run:() => togglePin(project)});
    candidates.push({label:"Remove current project from recents",glyph:"close",run:forget});
  }
  if (terminalDock) {
    candidates.push({label:"Copy terminal selection",glyph:"terminal",run:action(() => terminalDock!.copy())});
    candidates.push({label:"Paste into active terminal",glyph:"terminal",run:action(() => terminalDock!.paste())});
    candidates.push({label:"Clear terminal scrollback",glyph:"terminal",run:() => terminalDock?.clear()});
  }
  for (const path of projectPaths()) candidates.push({label:"Open " + nameOf(path), detail:path, glyph:"folder",run:() => {void openProject(path);}});
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
  query.focus();
}
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
  if (document.querySelector("dialog[open]") && !(key === "k" && palette.open)) return;
  let command: (() => void) | undefined;
  if (key === "k") command = showPalette;
  if (key === "o" && !event.shiftKey) command = pick;
  if (key === "t" && event.shiftKey) command = openTerminal;
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
  if (smoke && (smoke.mode === "workspace" || smoke.mode === "workspace-reopen")) {
    try {
      await showVersions();
      await initializeWorkspace();
      if (smoke.mode === "workspace-reopen") {
        if (!active || get("session-name").textContent !== "Review project" || prefs.theme !== "graphite" || !get("terminal-dock").hidden) {
          throw new Error("the app did not restore the saved project, session, and theme");
        }
        await api.report(JSON.stringify({step:"workspace-restored",theme:prefs.theme,session:active}),true);
        return;
      }
      const { checkWorkspace } = await import("./workspace-check");
      const state = await checkWorkspace(smoke,choose,open,refreshProvider,() => saved);
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
