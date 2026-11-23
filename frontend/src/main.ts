import { api, onAuthURL, onFrames, type Challenge, type EngineEvent, type Frame, type Reply, type Session } from "./api";
import { runSmoke } from "./smoke";
import "./style.css";

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

function drawNavigation() {
  const key = JSON.stringify([projects, project, sessions, active,
    [...tabs.values()].map(tab => [tab.session.id, tab.running, !!tab.input])]);
  if (key === navigationKey) return;
  navigationKey = key;
  get("projects").replaceChildren(...projects.map(path => {
    const b = button(nameOf(path), action(async () => choose(await api.select(path))), "project");
    b.title = path;
    b.setAttribute("aria-current", String(path === project));
    return b;
  }));
  get("project-sessions").hidden = !project;
  get("existing").replaceChildren(...sessions.map((item, index) => {
    const b = button(index === 0 ? "Latest · " + item.id.slice(-7) : "Session · " + item.id.slice(-7), action(() => open(item)), "session-item");
    b.title = item.id;
    b.setAttribute("aria-current", String(active === item.id));
    return b;
  }));
  get("tabs").replaceChildren(...Array.from(tabs.values(), tab => {
    const selected = active === tab.session.id;
    const wrap = element("div", "", selected ? "tab selected" : "tab");
    const marker = tab.input ? " · Needs input" : tab.running ? " · Running" : "";
    const select = button(nameOf(tab.session.project) + " · " + tab.session.id.slice(-5) + marker, () => setActive(tab.session.id));
    select.setAttribute("aria-current", String(selected));
    const close = button("×", () => {
      tabs.delete(tab.session.id);
      if (selected) setActive(Array.from(tabs.keys()).at(-1) ?? "");
      else drawNavigation();
    }, "close-tab");
    close.disabled = tab.running;
    close.setAttribute("aria-label", "Close " + tab.session.id);
    wrap.append(select, close);
    return wrap;
  }));
}

function setActive(id: string) {
  active = id;
  const tab = tabs.get(id);
  prompt.value = tab?.draft ?? "";
  inputKey = "";
  announce();
  drawNavigation();
  drawSession();
}

async function choose(path: string) {
  if (!path) return;
  project = path;
  sessions = [];
  drawNavigation();
  const [nextProjects, nextSessions] = await Promise.all([api.projects(), api.sessions(path)]);
  projects = nextProjects;
  if (project === path) sessions = nextSessions;
  drawNavigation();
  if (project === path && (!active || tabs.get(active)?.session.project !== path)) {
    if (sessions[0]) await open(sessions[0]);
    else setActive("");
  }
}
async function open(session: Session) {
  if (tabs.has(session.id)) { setActive(session.id); return; }
  const tab: Tab = { session, entries: [], children: new Map(), toolNames: new Map(), draft: "", partial: "", running: false, status: "Ready", loading: true };
  tabs.set(session.id, tab);
  setActive(session.id);
  try {
    const history = await api.history(session);
    if (history.truncated) add(tab, { role: "system", text: "Showing recent messages. The engine retains the full session journal." });
    for (const message of history.messages) add(tab, { role: message.role, text: message.content });
  } finally {
    tab.loading = false;
    if (active === session.id) drawSession();
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
  if (!tab) return;
  const switching = previousTab !== active;
  previousTab = active;
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
  get("session-name").textContent = nameOf(tab.session.project);
  get("session-path").textContent = tab.session.project;
  get("run-status").textContent = tab.input ? "Needs input" : tab.toolProgress ? limit(tab.toolProgress, 45) : tab.status;
  get<HTMLButtonElement>("send").disabled = tab.running || tab.loading || !!tab.recovery;
  get("cancel").hidden = !tab.running;
  const entries = tab.partial ? [...tab.entries, { role: "assistant", text: tab.partial }] : tab.entries;
  // Keep existing nodes and update only entries that changed.
  for (const [index, e] of entries.entries()) {
    const current = transcript.children[index] as HTMLElement | undefined;
    const label = e.label ?? (e.role === "user" ? "You" : e.role === "assistant" ? "GoHarness" : e.role === "tool" ? "Tool output" : "");
    if (current?.dataset.role === e.role && current.dataset.label === label && current.lastChild?.textContent === e.text) continue;
    const row = element("article", "", "message " + e.role);
    row.dataset.role = e.role;
    row.dataset.label = label;
    if (label) row.append(element("small", label));
    row.append(document.createTextNode(e.text));
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
get("create").onclick = action(async () => {
  const chosen = project;
  const session = await api.create(chosen);
  if (project === chosen) sessions = await api.sessions(chosen);
  await open(session);
});
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

void action(async () => {
  const smoke = await api.smoke();
  const versions = await api.versions();
  get("versions").textContent = "Desktop " + versions.desktop + " · Engine " + versions.engine + (versions.channel === "preview" ? " · Preview" : "");
  projects = await api.projects();
  drawNavigation();
  if (smoke) {
    await runSmoke(smoke, name => { get("versions").textContent = name; });
    return;
  }
  const provider = await refreshProvider();
  if (!provider.model) providerDialog.showModal();
}, announce)();
