import { api, type Session, type Smoke } from "./api";

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;

function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

async function waitFor(condition: () => boolean, reason: string) {
  const deadline = performance.now() + 18000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(reason + " · " + get("alert").textContent);
    await new Promise(resolve => setTimeout(resolve, 45));
  }
}

async function rejects(action: PromiseLike<unknown>, pattern: RegExp) {
  try { await action; }
  catch (error) { assert(pattern.test(String(error)), "unexpected error: " + error); return; }
  throw new Error("operation unexpectedly accepted: " + pattern);
}

export async function checkAudit(
  config: Smoke,
  choose: (path: string) => Promise<void>,
  open: (session: Session) => Promise<void>,
  report: (step: string, quit?: boolean) => Promise<void>,
  saved: () => Promise<void>,
) {
  const [first, second, recoveryPath] = await Promise.all(config.projects.map(path => api.select(path)));
  const prompt = get<HTMLTextAreaElement>("prompt");
  const challenge = get("challenge");
  const draft = () => prompt.value;
  const status = () => get("run-status").textContent ?? "";
  const messages = () => get("messages").textContent ?? "";
  const provider = get<HTMLDialogElement>("provider-dialog");
  const providerStatus = () => get("provider-status").textContent ?? "";
  const fillPrompt = (value: string) => {
    prompt.value = value;
    prompt.dispatchEvent(new Event("input"));
  };
  const run = (value: string) => {
    fillPrompt(value);
    get<HTMLFormElement>("composer").requestSubmit();
  };
  const button = (scope: HTMLElement, title: string) => {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === title);
    assert(match, "missing action " + title);
    return match;
  };
  const saveProvider = () => get<HTMLFormElement>("provider-form").requestSubmit();
  const formValue = (id: string, value: string) => { get<HTMLInputElement>(id).value = value; };

  await choose(first);
  get("provider").click();
  await waitFor(() => provider.open && providerStatus().includes("legacy-scripted"), "existing GoHarness provider was unavailable");
  get<HTMLDetailsElement>("provider-custom").open = true;
  formValue("endpoint", "http://api.example.com/v1");
  formValue("model", "scripted");
  saveProvider();
  await waitFor(() => providerStatus().includes("use HTTPS"), "an insecure remote endpoint was accepted");
  assert((await api.provider()).model === "legacy-scripted", "invalid provider replaced existing settings");
  formValue("endpoint", config.endpoint);
  saveProvider();
  await waitFor(() => providerStatus().includes("Provider saved"), "corrected provider settings did not save");
  get("close-provider").click();

  const left = await api.create(first + "/left");
  const right = await api.create(first + "/right");
  const foreign = await api.create(second);
  const recovery = (await api.sessions(recoveryPath))[0];
  assert(recovery, "missing seeded recovery journal");
  await open(left);
  run('fixture verify file rules @"private-context.txt"');
  await waitFor(() => messages().includes("Denied file stayed private"),
    "desktop provider override dropped the engine's file rules");
  await waitFor(() => status() === "No changes" && get("cancel").hidden, "file-rule check did not settle");
  assert(!get("messages").querySelector(".message-attachments"), "desktop showed an attachment the engine denied");

  run("fixture write");
  await waitFor(() => !challenge.hidden && challenge.textContent!.includes("Review proposed edit"), "approval did not open");
  await rejects(api.saveProvider({ protocol: "" }), /finish active sessions/i);

  await open(right);
  run("contents of the blocked draft");
  await waitFor(() => (get("alert").textContent ?? "").includes("running in this checkout"), "sibling folders could start separate writers");
  assert(draft() === "contents of the blocked draft", "checkout contention lost the draft");
  await open(foreign);
  run("fixture question many");
  await waitFor(() => !challenge.hidden && challenge.textContent!.includes("Which colors?"), "multi-answer question did not open");
  await rejects(api.start(recovery, "no third simultaneous run"), /both run slots/i);
  button(challenge, "Submit answers").click();
  await waitFor(() => (challenge.textContent ?? "").includes("Choose or enter an answer"), "empty question was accepted");
  const choices = [...challenge.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert(choices.length === 2, "multiple answers were not rendered as checkboxes");
  for (const choice of choices) choice.click();
  const custom = challenge.querySelector<HTMLInputElement>('input[placeholder="Other answer"]')!;
  custom.value = "Custom shade";
  button(challenge, "Submit answers").click();
  await waitFor(() => messages().includes("All question answers received"), "question choices did not reach the provider");
  await waitFor(() => get("cancel").hidden, "question run did not end");
  await open(left);
  button(challenge, "Deny").click();
  await waitFor(() => get("cancel").hidden, "denied run remained active");
  await open(right);
  assert(draft() === "contents of the blocked draft", "switching tabs replaced the unsent draft");

  await open(foreign);
  run("fixture reject provider request");
  await waitFor(() => get("cancel").hidden && /401|unauthorized/i.test(get("alert").textContent ?? ""),
    "a provider rejection had no actionable diagnostic");
  run("fixture provider follow-up");
  await waitFor(() => status() === "No changes" && get("cancel").hidden && messages().includes("Provider recovered"),
    "session did not recover from the provider error");

  for (const [protocol, reply] of [
    ["openai_responses", "Responses fixture received"],
    ["anthropic_messages", "Messages fixture received"],
  ]) {
    get("provider").click();
    await waitFor(() => provider.open && providerStatus().includes("Desktop"), "desktop provider settings disappeared");
    get<HTMLSelectElement>("protocol").value = protocol;
    formValue("api-key", "goh-desktop-audit-fixture");
    saveProvider();
    await waitFor(() => providerStatus().includes("Provider saved"), "provider switch did not save");
    assert(get<HTMLInputElement>("api-key").value === "", "provider key remained in the form after saving");
    get("close-provider").click();
    run("fixture " + protocol);
    await waitFor(() => messages().includes(reply) && get("cancel").hidden, "streaming failed for " + protocol);
  }

  get("provider").click();
  await waitFor(() => provider.open && providerStatus().includes("Desktop"), "desktop provider settings disappeared");
  get("engine-settings").click();
  await waitFor(() => providerStatus().includes("legacy-scripted"), "could not restore GoHarness provider settings");
  get("close-provider").click();

  await choose(recoveryPath);
  await open(recovery);
  const retry = "fixture review uncertain effects";
  run(retry);
  await waitFor(() => !challenge.hidden && challenge.textContent!.includes("Review uncertain effects"), "engine did not require acknowledgement");
  assert(draft() === retry && !messages().includes(retry), "a rejected run consumed the draft or added a phantom turn");
  assert(challenge.textContent!.includes("fixture-interrupted-effect"), "uncertain effect ID was hidden");
  button(challenge, "Acknowledge and retry").click();
  await waitFor(() => messages().includes("scripted response") && get("cancel").hidden, "explicit acknowledgement did not resume");
  assert(draft() === "", "successful acknowledgement left the sent draft in the composer");
  assert([...get("messages").querySelectorAll(".message.user")].filter(row => row.textContent?.includes(retry)).length === 1, "retry did not render exactly one turn");
  assert((await api.history(recovery)).messages.filter(message => message.content === retry).length === 1, "retry did not journal exactly one turn");

  await saved();
  await report("audit-idle");
  // Give the external process inspector time to observe the expired helpers
  // while the desktop is still alive.
  await new Promise(resolve => setTimeout(resolve, 18000));
  await open(recovery);
  await saved();
  const state = await api.workspace();
  assert(state.active === recovery.id && state.project === recovery.project, "audit did not persist the selected recovery project");
  await report("audit-passed", true);
}
