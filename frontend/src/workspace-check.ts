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
  insertReferences: (session: Session, refs: string[]) => void,
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
  const mode = get<HTMLSelectElement>("agent-mode");
  const idle = () => get("cancel").hidden && !mode.disabled;
  const changeMode = (value: string) => {
    mode.value = value;
    mode.dispatchEvent(new Event("change"));
  };
  const includesMessage = (text: string) => [...get("messages").querySelectorAll(".assistant")].some(node => node.textContent?.includes(text));
  await waitFor(idle, "first Build run did not finish");
  changeMode("plan");
  run("fixture plan review");
  await waitFor(() => challenge.textContent!.includes("Review proposed plan"), "Plan handoff was not presented for review");
  if (!mode.disabled || !challenge.textContent!.includes("Inspect fixture files before editing.")) throw new Error("Plan preview or active mode lock was missing");
  let blocked = false;
  try { await api.smokeExportSession(created, "markdown", false); }
  catch (error) { blocked = String(error).includes("finish before exporting"); }
  if (!blocked) throw new Error("active-session export was allowed");
  [...challenge.querySelectorAll<HTMLButtonElement>("button")].find(control => control.textContent === "Continue in Plan")!.click();
  await waitFor(idle, "Plan did not finish after the manual review");
  const refs = await api.smokeFileReferences(created, [second + "/context café.txt", second + "/supplement.txt"]);
  if (refs.length !== 2 || refs[0] !== '@"context café.txt"') throw new Error("picker did not quote a space and Unicode filename");
  let outside = false;
  try { await api.smokeFileReferences(created, [first + "/context café.txt"]); }
  catch (error) { outside = String(error).includes("inside this session's project"); }
  if (!outside) throw new Error("picker accepted a file from another project");
  const prefix = "fixture verify context";
  prompt.value = prefix;
  prompt.dispatchEvent(new Event("input"));
  prompt.setSelectionRange(prefix.length, prefix.length);
  insertReferences(created, refs);
  if (!prompt.value.includes(refs.join(" "))) throw new Error("the references were not inserted in the editable draft");
  get<HTMLFormElement>("composer").requestSubmit();
  await waitFor(() => idle() && includesMessage("Context files received"), "scripted provider did not receive both attachments");
  const attachments = get("messages").querySelector(".message-attachments");
  if (!attachments?.textContent?.includes("context café.txt") || !attachments.textContent.includes("supplement.txt") ||
      get("messages").textContent?.includes("CONTEXT_FIXTURE_SECRET_MARKER")) {
    throw new Error("the engine's attachment event failed to update the correct prompt");
  }
  run("fixture inspect tools");
  await waitFor(() => idle() && includesMessage("Plan tools only"), "engine did not restrict Plan tools");
  changeMode("build");
  run("fixture inspect tools");
  await waitFor(() => idle() && includesMessage("Build tools available"), "engine did not offer Build tools on the same session");
  const posix = !/Win/.test(navigator.platform);
  if (posix) {
    run("fixture write and verify");
    for (const preview of ["Review proposed edit", "test -f note.txt"]) {
      await waitFor(() => !challenge.hidden && challenge.textContent!.includes(preview), "missing verification fixture approval");
      [...challenge.querySelectorAll<HTMLButtonElement>("button")].find(control => control.textContent === "Allow once")!.click();
    }
    await waitFor(idle, "verification run did not complete");
  }
  get("run-details").click();
  const runText = get("run-list").textContent ?? "";
  if (!runText.includes("No changes") || !runText.includes("plan") || !runText.includes("build") ||
      (posix && (!runText.includes("Verified") || !runText.includes("test -f note.txt") || !runText.includes("Exit code 0")))) {
    throw new Error("run history did not show the engine's outcomes and evidence: " + runText);
  }
  get("close-runs").click();
  get("session-export").click();
  const format = get<HTMLSelectElement>("export-format");
  if (format.value !== "markdown" || get<HTMLInputElement>("export-tools").checked) throw new Error("export did not default to a transcript without tools");
  format.value = "json";
  format.dispatchEvent(new Event("change"));
  if (!get("export-tools-option").hidden) throw new Error("portable archive offered a Markdown-only option");
  get("close-export").click();
  await api.smokeExportSession(created, "markdown", false);
  await api.smokeExportSession(created, "json", false);
  let collision = false;
  try { await api.smokeExportSession(created, "markdown", false); }
  catch (error) { collision = String(error).includes("must not exist"); }
  if (!collision) throw new Error("export replaced an existing transcript");
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
