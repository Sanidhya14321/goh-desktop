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
  refreshProvider: () => Promise<unknown>,
  saveQueue: () => Promise<void>,
) {
  get("palette").click();
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

  await api.saveProvider({protocol:"chat_completions",base_url:smoke.endpoint,model:"scripted"});
  await refreshProvider();
  const created = await api.create(second);
  await open(created);
  get("rename-session").click();
  get<HTMLInputElement>("rename-value").value = "Review project";
  get<HTMLFormElement>("rename-form").requestSubmit();
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
