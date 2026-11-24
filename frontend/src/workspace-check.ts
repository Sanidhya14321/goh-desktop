import { api, type Session, type Smoke } from "./api";

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const terminalTabs = () => [...document.querySelectorAll<HTMLButtonElement>("#terminal-tabs .terminal-tab > button:first-child")];

async function waitFor(check: () => boolean, failure: string) {
  const until = performance.now() + 9000;
  while (performance.now() < until) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve,45));
  }
  throw new Error(failure + (get("alert").textContent ? " · " + get("alert").textContent : ""));
}

export async function checkWorkspace(
  smoke: Smoke,
  choose: (path: string) => Promise<void>,
  open: (session: Session) => Promise<void>,
  saveQueue: () => Promise<void>,
) {
  const mac = /Mac/.test(navigator.platform);
  document.dispatchEvent(new KeyboardEvent("keydown", { key:"P", shiftKey:true, metaKey:mac, ctrlKey:!mac }));

  await waitFor(() => get<HTMLDialogElement>("palette-dialog").open && get("palette-results").textContent!.includes("New terminal"), "command palette did not open");
  get<HTMLDialogElement>("palette-dialog").close();
  get("settings").click();
  get<HTMLSelectElement>("theme").value = "graphite";
  get("theme").dispatchEvent(new Event("change"));
  get<HTMLSelectElement>("density").value = "compact";
  get("density").dispatchEvent(new Event("change"));
  get("close-settings").click();
  await saveQueue();
  const stored = await api.workspace();
  if (stored.theme !== "graphite" || stored.density !== "compact" || document.documentElement.dataset.theme !== "graphite") {
    throw new Error("workspace settings did not save");
  }

  const first = await api.select(smoke.projects[0]);
  const second = await api.select(smoke.projects[1]);
  await choose(first);
  get("welcome-terminal").click();
  await waitFor(() => terminalTabs().length === 1 && !!document.querySelector(".xterm"), "first terminal did not render");
  await choose(second);
  get("terminal-add").click();
  await waitFor(() => terminalTabs().length === 2 && document.querySelectorAll(".xterm").length === 2, "second terminal did not render");
  get("terminal-split").click();
  await waitFor(() => get("terminal-panes").classList.contains("split") && document.querySelectorAll(".terminal-surface:not([hidden])").length === 2,
    "terminal split did not open");
  const panes = [...document.querySelectorAll<HTMLElement>(".terminal-surface")];
  for (const [index,pane] of panes.entries()) {
    const terminal = pane.dataset.terminalId!;
    await waitFor(() => !terminalTabs()[index].textContent!.startsWith("Terminal "), "terminal connection was not established");
    const marker = index === 0 ? "FIRST_PANE_OUTPUT" : "SECOND_PANE_OUTPUT";
    await api.writeTerminal(terminal,"echo " + marker + "\r");
    await api.writeTerminal(terminal,"pwd\r");
    const output = () => pane.querySelector(".xterm-rows")?.textContent ?? "";
    const directory = index === 0 ? "first project" : "second project";
    await waitFor(() => output().includes(marker) && output().includes(directory),
      "shell output did not reach its project terminal");
  }
  const allProjects = [...document.querySelectorAll("#projects .project")];
  if (!allProjects.some(node => node.textContent?.includes("first project")) ||
      !allProjects.some(node => node.textContent?.includes("second project"))) {
    throw new Error("opening a project removed its sibling from the workspace");
  }

  terminalTabs()[0].click();
  get("terminal-rename").click();
  get<HTMLInputElement>("terminal-rename-value").value = "Build shell";
  get<HTMLFormElement>("terminal-rename-form").requestSubmit();
  await waitFor(() => terminalTabs()[0].textContent!.includes("Build shell"),"terminal rename was not shown");
  const find = get<HTMLInputElement>("terminal-query");
  const search = async (term: string, expected: string) => {
    find.value = term;
    find.dispatchEvent(new Event("input"));
    await waitFor(() => get("terminal-match").textContent === expected,"terminal search returned an unexpected result");
  };
  get("terminal-find").click();
  await search("FIRST_PANE_OUTPUT","Match found");
  await search("SECOND_PANE_OUTPUT","No match");
  find.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  await waitFor(() => get("terminal-search").hidden &&
    document.activeElement?.closest(".terminal-surface") === panes[0],"closing Find did not return to the original shell");
  get("palette").click();
  const query = get<HTMLInputElement>("palette-query");
  query.value = "switch to build shell";
  query.dispatchEvent(new Event("input"));
  const switchTerminal = get("palette-results").querySelector<HTMLButtonElement>("button");
  if (!switchTerminal?.textContent?.includes("Switch to Build shell")) throw new Error("renamed terminal was missing from the command palette");
  switchTerminal.click();

  const duplicateA = await api.select(first + "/common");
  const duplicateB = await api.select(second + "/common");
  await choose(second);
  const suffixes = [...document.querySelectorAll(".project-parent")].map(node => node.textContent);
  if (!suffixes.includes("first project") || !suffixes.includes("second project")) throw new Error("matching project names were not disambiguated");
  if (duplicateA === duplicateB) throw new Error("fixture did not create independent folders");

  // A fresh user starts New Session, completes provider setup, and lands in
  // the same project without requesting a second session.
  get("welcome-session").click();
  const provider = get<HTMLDialogElement>("provider-dialog");
  await waitFor(() => provider.open && get("provider-intent").textContent!.includes("second project"),"provider setup lost the selected project");
  get<HTMLDetailsElement>("provider-custom").open = true;
  get<HTMLInputElement>("endpoint").value = smoke.endpoint;
  get<HTMLInputElement>("model").value = "scripted";
  get<HTMLFormElement>("provider-form").requestSubmit();
  await waitFor(() => !provider.open && !get("session").hidden && get("session-path").textContent === second, "provider setup did not resume New Session");
  const created = (await api.sessions(second))[0];
  await waitFor(() => !get("starter-prompt").hidden,"the first session did not offer a starter prompt");
  get("starter-prompt").click();
  const prompt = get<HTMLTextAreaElement>("prompt");
  if (!prompt.value.includes("Do not modify") || (await api.history(created)).messages.length) {
    throw new Error("the starter prompt was not editable before sending");
  }
  const run = (text: string) => {
    prompt.value = text;
    prompt.dispatchEvent(new Event("input"));
    get<HTMLFormElement>("composer").requestSubmit();
  };
  get("rename-session").click();
  get<HTMLInputElement>("rename-value").value = "Review project";
  get<HTMLFormElement>("rename-form").requestSubmit();
  run("fixture write");
  // Opening a helper can take a moment. Let each project keep its own session
  // while the webview waits on real approval and question frames.
  const other = await api.create(first);
  await open(other);
  run("fixture question");
  await waitFor(() => get("attention-count").textContent === "Needs input · 2","the other project's blocked run was not surfaced");
  prompt.value = "follow-up draft";
  prompt.dispatchEvent(new Event("input"));
  const jump = (id: string) => {
    get("attention").click();
    const entry = [...get("attention-list").querySelectorAll<HTMLButtonElement>("button")].find(row => row.dataset.session === id);
    if (!entry) throw new Error("pending input was missing from the list");
    entry.click();
  };
  jump(created.id);
  const challenge = get("challenge");
  if (get("session-path").textContent !== second || document.activeElement !== challenge ||
      !challenge.textContent?.includes("Proposed edit") && !challenge.textContent?.includes("proposed edit")) {
    throw new Error("approval did not focus its owning session");
  }
  if (get("attention-count").textContent !== "Needs input · 2") throw new Error("viewing an approval marked it resolved");
  [...challenge.querySelectorAll<HTMLButtonElement>("button")].find(control => control.textContent === "Deny")!.click();
  await waitFor(() => get("attention-count").textContent === "Needs input · 1","the resolved approval stayed in the list");
  jump(other.id);
  if (prompt.value !== "follow-up draft" || get("session-path").textContent !== first || !challenge.textContent?.includes("Which color?")) {
    throw new Error("review navigation replaced the other session's draft or opened the wrong question");
  }
  [...challenge.querySelectorAll<HTMLButtonElement>("button")].find(control => control.textContent === "Dismiss")!.click();
  await waitFor(() => get("attention").hidden,"the resolved question stayed in the list");
  await open(created);
  await saveQueue();
  const savedWorkspace = await api.workspace();
  if (savedWorkspace.names[created.id] !== "Review project" ||
      !savedWorkspace.tabs.some(tab => tab.id === created.id && tab.project === second)) {
    throw new Error("session rename or restoration state did not persist");
  }

  const close = document.querySelector<HTMLButtonElement>("#terminal-tabs .terminal-tab:last-child .icon-button")!;
  close.click();
  await waitFor(() => terminalTabs().length === 1 && !get("terminal-panes").classList.contains("split"), "closing a terminal did not collapse the split");
  return savedWorkspace;
}
