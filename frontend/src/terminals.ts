import { Clipboard } from "@wailsio/runtime";
import { Terminal, type ITheme } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { FitAddon } from "@xterm/addon-fit";
import { api, onTerminal, type TerminalPacket } from "./api";
import { icon } from "./icons";

type Pane = {
  id: string; title: string; project: string; surface: HTMLElement; content: HTMLElement;
  terminal: Terminal; fit: FitAddon; search?: SearchAddon; waiting: Map<number, TerminalPacket>;
  seq: number; pendingInput: string; writing: boolean; connected: boolean; ended: boolean; size: string;
};

const themes: Record<string, ITheme> = {
  ember: { background: "#151311", foreground: "#f5eee6", cursor: "#efad83", selectionBackground: "#5a4232", brightBlack: "#a29383", green: "#9bc69f" },
  graphite: { background: "#131519", foreground: "#eceef2", cursor: "#aabfff", selectionBackground: "#39466b", brightBlack: "#939dab", green: "#9bc69f" },
  contrast: { background: "#080808", foreground: "#ffffff", cursor: "#ffca9e", selectionBackground: "#68574a", brightBlack: "#b4b4b4", green: "#a8e3af" },
};
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;

function control(label: string, glyph: string, click: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(icon(glyph));
  button.onclick = click;
  return button;
}

export class TerminalDock {
  private panes = new Map<string, Pane>();
  private primary = "";
  private secondary = "";
  private focused = "";
  private searching = "";
  private renaming = "";
  private searchInput = get<HTMLInputElement>("terminal-query");
  private nameInput = get<HTMLInputElement>("terminal-rename-value");
  private renameDialog = get<HTMLDialogElement>("terminal-rename-dialog");
  private open = false;
  private fontSize = 13;
  private theme = themes.ember;
  private label = 0;
  private frame = 0;

  constructor(
    private dock: HTMLElement,
    private tabs: HTMLElement,
    private surfaces: HTMLElement,
    private changed: (open: boolean, count: number, split: boolean) => void,
    private report: (error: unknown) => void,
  ) {
    onTerminal(packet => this.receive(packet));
    new ResizeObserver(() => this.scheduleFit()).observe(surfaces);
    get("terminal-find").onclick = () => this.find();
    get("terminal-rename").onclick = () => this.rename();
    get("terminal-close-find").onclick = () => this.closeFind();
    get("terminal-previous").onclick = () => this.search(false);
    get("terminal-next").onclick = () => this.search(true);
    this.searchInput.oninput = () => this.search(true, true);
    this.searchInput.onkeydown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeFind();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.search(!event.shiftKey);
      }
    };
    get("terminal-rename-cancel").onclick = () => this.renameDialog.close();
    this.renameDialog.addEventListener("close", () => {
      this.panes.get(this.renaming)?.terminal.focus();
      this.renaming = "";
    });
    get<HTMLFormElement>("terminal-rename-form").onsubmit = event => {
      event.preventDefault();
      const pane = this.panes.get(this.renaming);
      if (!pane || !this.nameInput.value.trim()) return;
      pane.title = this.nameInput.value.trim();
      this.renameDialog.close();
      this.draw();
    };
  }

  configure(theme: string, fontSize: number) {
    this.theme = themes[theme] ?? themes.ember;
    this.fontSize = fontSize;
    for (const pane of this.panes.values()) {
      pane.terminal.options.theme = this.theme;
      pane.terminal.options.fontSize = this.fontSize;
    }
    this.scheduleFit();
  }

  toggle() { this.show(!this.open); }
  show(show: boolean) {
    if (!show) this.closeFind(false);
    this.open = show;
    this.draw();
  }

  async add(project: string, shell: string, split = false) {
    this.show(true);
    const id = "term-" + Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2,"0")).join("");
    const surface = document.createElement("div");
    surface.className = "terminal-surface";
    surface.dataset.terminalId = id;
    const title = document.createElement("div");
    title.className = "terminal-location";
    title.title = project;
    title.textContent = project;
    const content = document.createElement("div");
    content.className = "terminal-screen";
    surface.append(title, content);
    this.surfaces.append(surface);
    const terminal = new Terminal({
      theme: this.theme, fontSize: this.fontSize, lineHeight: 1.16,
      fontFamily: "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
      cursorBlink: true, scrollback: 2500, allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const pane: Pane = { id, title: "Terminal " + ++this.label, project, surface, content, terminal, fit,
      seq: 0, waiting: new Map(), pendingInput: "", writing: false, connected: false, ended: false, size: "" };
    const initialTitle = pane.title;
    this.panes.set(id, pane);
    if (split && this.primary) this.secondary = id;
    else this.primary = id;
    this.draw();
    terminal.open(content);
    surface.addEventListener("focusin", () => { this.updateFocus(id); });
    fit.fit();
    terminal.onData(text => this.queueInput(pane, text));
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown") return true;
      const mac = /Mac/.test(navigator.platform);
      const modifier = mac ? event.metaKey : event.ctrlKey && event.shiftKey;
      if (!modifier) return true;
      if (event.key.toLowerCase() === "c" && terminal.hasSelection()) {
        void Clipboard.SetText(terminal.getSelection()).catch(this.report);
        event.preventDefault();
        return false;
      }
      if (event.key.toLowerCase() === "v") {
        void Clipboard.Text().then(result => { if (result) terminal.paste(result); }).catch(this.report);
        event.preventDefault();
        return false;
      }
      return true;
    });
    try {
      const actual = await api.openTerminal(id, project, shell, terminal.cols, terminal.rows);
      if (pane.title === initialTitle) pane.title = String(this.labelFor(pane)) + " " + actual.name;
      pane.connected = !pane.ended;
      this.draw();
      if (pane.connected) terminal.focus();
    } catch (error) {
      pane.ended = true;
      terminal.options.disableStdin = true;
      terminal.writeln("\r\n" + String(error).replace(/[\x00-\x1f\x7f]/g, " "));
      this.draw();
      this.report(error);
    }
  }

  async split(project: string, shell: string) {
    if (this.secondary) { this.secondary = ""; this.draw(); return; }
    if (!this.primary) { await this.add(project,shell); return; }
    const other = [...this.panes.keys()].reverse().find(key => key !== this.primary);
    if (other) { this.secondary = other; this.draw(); }
    else await this.add(this.focusedPane()?.project ?? project,shell,true);
  }

  private focusedPane() {
    const pane = this.panes.get(this.focused);
    return pane && !pane.surface.hidden ? pane : this.panes.get(this.primary);
  }

  entries() {
    return [...this.panes.values()].map(({id,title,project,ended}) => ({id,title,project,ended}));
  }

  select(id: string) {
    const pane = this.panes.get(id);
    if (!pane) return;
    if (this.searching && this.searching !== id) this.closeFind(false);
    const visible = this.primary === id || this.secondary === id;
    if (!visible) this.primary = id;
    if (!this.open || !visible) this.show(true);
    pane.terminal.focus();
    this.updateFocus(id);
  }

  rename(pane = this.focusedPane()) {
    if (!pane || this.renameDialog.open) return;
    this.renaming = pane.id;
    this.nameInput.value = pane.title;
    this.renameDialog.showModal();
    this.nameInput.select();
  }

  find() {
    const pane = this.focusedPane();
    if (!pane) return;
    this.show(true);
    if (this.searching !== pane.id) {
      this.closeFind(false);
      this.searching = pane.id;
      this.searchInput.value = "";
    }
    if (!pane.search) {
      pane.search = new SearchAddon();
      pane.terminal.loadAddon(pane.search);
    }
    const label = "Find in " + pane.title;
    this.searchInput.placeholder = label;
    this.searchInput.setAttribute("aria-label",label);
    get("terminal-search").hidden = false;
    this.searchInput.focus();
    this.searchInput.select();
    this.scheduleFit();
  }

  private search(forward: boolean, incremental = false) {
    const pane = this.panes.get(this.searching);
    if (!pane?.search) return;
    const query = this.searchInput.value;
    if (!query) {
      pane.search.clearDecorations();
      get("terminal-match").textContent = "";
      return;
    }
    const match = forward ? pane.search.findNext(query,{incremental}) : pane.search.findPrevious(query);
    get("terminal-match").textContent = match ? "Match found" : "No match";
  }

  private closeFind(focus = true) {
    const pane = this.panes.get(this.searching);
    this.searching = "";
    pane?.search?.clearDecorations();
    get("terminal-search").hidden = true;
    get("terminal-match").textContent = "";
    if (focus && pane && !pane.surface.hidden) pane.terminal.focus();
    this.scheduleFit();
  }

  private updateFocus(id: string) {
    this.focused = id;
    if (this.searching && this.searching !== id) this.closeFind(false);
    for (const [key,pane] of this.panes) {
      pane.surface.classList.toggle("focused",key === id);
      const tab = this.tabs.querySelector<HTMLElement>('[data-terminal-tab="' + key + '"]');
      tab?.classList.toggle("focused",key === id);
    }
  }

  async copy() {
    const selected = this.focusedPane()?.terminal.getSelection();
    if (selected) await Clipboard.SetText(selected);
  }

  async paste() {
    const pane = this.focusedPane();
    if (!pane?.connected) return;
    const value = await Clipboard.Text();
    if (value) {
      this.show(true);
      pane.terminal.focus();
      pane.terminal.paste(value);
    }
  }

  clear() { this.focusedPane()?.terminal.clear(); }

  private labelFor(pane: Pane) { return pane.title.replace("Terminal ", ""); }

  private queueInput(pane: Pane, text: string) {
    if (!pane.connected) return;
    if (pane.pendingInput.length + text.length > 256 << 10) {
      this.report(new Error("Terminal input exceeds the pending input limit."));
      return;
    }
    pane.pendingInput += text;
    if (!pane.writing) void this.drainInput(pane);
  }

  private async drainInput(pane: Pane) {
    pane.writing = true;
    try {
      while (pane.connected && pane.pendingInput) {
        // Limit string size before the host UTF-8 encoding step.
        let length = Math.min(12 << 10, pane.pendingInput.length);
        if (/[\uD800-\uDBFF]/.test(pane.pendingInput[length - 1]) && length < pane.pendingInput.length) length--;
        const chunk = pane.pendingInput.slice(0,length);
        pane.pendingInput = pane.pendingInput.slice(length);
        await api.writeTerminal(pane.id, chunk);
      }
    } catch (error) {
      if (pane.connected) this.report(error);
      pane.pendingInput = "";
    } finally {
      pane.writing = false;
    }
  }

  private receive(packet: TerminalPacket) {
    const pane = this.panes.get(packet.id);
    if (!pane || packet.sequence <= pane.seq) return;
    pane.waiting.set(packet.sequence, packet);
    if (pane.waiting.size > 256) {
      pane.waiting.clear();
      this.report(new Error("Terminal output could not be delivered in order."));
      void this.remove(pane);
      return;
    }
    while (pane.waiting.has(pane.seq + 1)) {
      const next = pane.waiting.get(++pane.seq)!;
      pane.waiting.delete(pane.seq);
      if (next.data) pane.terminal.write(Uint8Array.from(atob(next.data), char => char.charCodeAt(0)));
      if (next.exit !== undefined) {
        pane.ended = true;
        pane.connected = false;
        pane.terminal.options.disableStdin = true;
        pane.terminal.writeln("\r\nShell exited" + (next.exit >= 0 ? " (" + next.exit + ")" : "") + ".");
        this.draw();
      }
    }
  }

  private async remove(pane: Pane) {
    try {
      await api.closeTerminal(pane.id);
      if (this.searching === pane.id) this.closeFind(false);
      this.panes.delete(pane.id);
      pane.connected = false;
      pane.terminal.dispose();
      pane.surface.remove();
      if (this.secondary === pane.id) this.secondary = "";
      if (this.primary === pane.id) {
        this.primary = this.secondary || [...this.panes.keys()].at(-1) || "";
        this.secondary = "";
      }
      this.draw();
    } catch (error) { this.report(error); }
  }

  private draw() {
    this.dock.hidden = !this.open;
    this.surfaces.classList.toggle("split", !!this.secondary);
    if (this.focused !== this.primary && this.focused !== this.secondary) this.focused = this.primary;
    const buttons: HTMLElement[] = [];
    for (const pane of this.panes.values()) {
      const selected = pane.id === this.primary || pane.id === this.secondary;
      pane.surface.hidden = !selected;
      pane.surface.classList.toggle("focused",pane.id === this.focused);
      pane.surface.style.order = pane.id === this.primary ? "0" : "1";
      const wrapper = document.createElement("div");
      wrapper.className = "terminal-tab" + (selected ? " current" : "") + (pane.id === this.focused ? " focused" : "");
      wrapper.dataset.terminalTab = pane.id;
      const select = document.createElement("button");
      select.textContent = pane.title + " · " + baseName(pane.project);
      select.title = pane.project + (pane.ended ? " · Exited" : "");
      select.setAttribute("aria-label",pane.title + " · " + pane.project + (pane.ended ? " · Exited" : ""));
      select.setAttribute("aria-pressed",String(selected));
      if (pane.ended) select.dataset.exited = "true";
      select.onclick = () => this.select(pane.id);
      select.ondblclick = () => this.rename(pane);
      wrapper.append(select,control("Close " + pane.title,"close",() => { void this.remove(pane); }));
      buttons.push(wrapper);
    }
    this.tabs.replaceChildren(...buttons);
    let placeholder = this.surfaces.querySelector<HTMLElement>(".terminal-empty");
    if (this.panes.size === 0 && !placeholder) {
      placeholder = document.createElement("p");
      placeholder.className = "terminal-empty";
      placeholder.textContent = "Open a terminal in the selected project.";
      this.surfaces.append(placeholder);
    } else if (this.panes.size > 0) placeholder?.remove();
    this.changed(this.open,this.panes.size,!!this.secondary);
    this.scheduleFit();
  }

  private scheduleFit() {
    cancelAnimationFrame(this.frame);
    if (!this.open) return;
    this.frame = requestAnimationFrame(() => {
      for (const pane of this.panes.values()) {
        if (pane.surface.hidden || !pane.terminal.element) continue;
        pane.fit.fit();
        const size = pane.terminal.cols + "x" + pane.terminal.rows;
        if (pane.size === size || !pane.connected) continue;
        pane.size = size;
        void Promise.resolve(api.resizeTerminal(pane.id,pane.terminal.cols,pane.terminal.rows)).catch(this.report);
      }
    });
  }
}
