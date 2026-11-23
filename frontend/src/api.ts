import { Call, Events } from "@wailsio/runtime";

export type Session = { id: string; project: string };
export type Versions = { desktop: string; engine: string; channel: string };
export type Provider = { protocol: string; base_url?: string; model?: string; key?: string; context_window?: number };
export type Question = { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean };
export type Challenge = { id: string; kind: string; data: { tool?: string; preview?: string; questions?: Question[] } };
export type EngineEvent = {
  type: string;
  data?: {
    id?: string; task_id?: string; agent?: string; event?: EngineEvent;
    text?: string; name?: string; tool?: string; target?: string; chars?: number;
    message?: string | { content?: string }; status?: string; outcome?: string;
    result?: { content?: string; error?: boolean };
  };
};
export type Frame = { event?: EngineEvent; input?: Challenge; end?: boolean; error?: string; pending?: unknown };
export type Reply = { allow: boolean } | { answers: string[][] } | { dismiss: boolean };
export type History = { messages: { role: string; content: string }[]; truncated: boolean };
export type Smoke = { projects: string[]; endpoint: string; report: string; mode: string };

const ns = "main.Service.";
const call = <T>(method: string, ...args: unknown[]): PromiseLike<T> => Call.ByName(ns + method, ...args);

export const api = {
  versions: () => call<Versions>("Versions"),
  projects: () => call<string[]>("RecentProjects"),
  pick: () => call<string>("PickProject"),
  select: (path: string) => call<string>("SelectProject", path),
  sessions: (path: string) => call<Session[]>("Sessions", path),
  create: (path: string) => call<Session>("Create", path),
  history: (session: Session) => call<History>("History", session),
  start: (session: Session, prompt: string, acknowledge = false) => call<void>("Start", session, prompt, acknowledge),
  answer: (session: Session, input: string, reply: Reply) => call<void>("Answer", session, input, reply),
  cancel: (session: Session) => call<void>("Cancel", session),
  provider: () => call<Provider & { source: string }>("ProviderStatus"),
  saveProvider: (p: Provider) => call<void>("SaveProvider", p),
  login: (switchAccount: boolean) => call<void>("Login", switchAccount),
  cancelLogin: () => call<void>("CancelLogin"),
  updateStatus: () => call<string>("UpdateStatus"),
  stageUpdate: () => call<string>("StageUpdate"),
  applyUpdate: () => call<void>("RestartForUpdate"),
  smoke: () => call<Smoke | null>("SmokeConfig"),
  report: (report: string, quit: boolean) => call<void>("SmokeReport", report, quit),
};

export function onFrames(receive: (id: string, frames: Frame[]) => void) {
  return Events.On("session:frames", ({ data }: { data: { id: string; frames: Frame[] } }) => receive(data.id, data.frames));
}
export function onAuthURL(receive: (url: string) => void) {
  return Events.On("provider:auth-url", ({ data }: { data: string }) => receive(data));
}
