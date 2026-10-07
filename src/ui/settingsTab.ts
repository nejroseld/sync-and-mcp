import { type App, PluginSettingTab, setIcon } from "obsidian";
import { t as tr } from "../i18n";
import type ObsiSyncPlugin from "../main";
import { renderAi } from "./settings/ai";
import { type SectionId, type SettingsContext, initialState } from "./settings/context";
import { renderDev } from "./settings/dev";
import { renderDevices } from "./settings/devices";
import { renderFolders } from "./settings/folders";
import { renderOverview } from "./settings/overview";
import { renderServer } from "./settings/server";
import { renderSync } from "./settings/sync";

const SECTIONS: Array<{ id: SectionId; label: string; icon: string; render: (ctx: SettingsContext, el: HTMLElement) => void }> = [
  { id: "overview", label: "Overview", icon: "layout-dashboard", render: renderOverview },
  { id: "sync", label: "Sync", icon: "refresh-cw", render: renderSync },
  { id: "folders", label: "Folders", icon: "folder", render: renderFolders },
  { id: "devices", label: "Devices", icon: "smartphone", render: renderDevices },
  { id: "ai", label: "AI", icon: "sparkles", render: renderAi },
  { id: "server", label: "Server", icon: "server", render: renderServer },
  { id: "dev", label: "Dev", icon: "bug", render: renderDev },
];

/** older links (welcome window, docs) used these section ids */
const ALIASES: Record<string, SectionId> = { connection: "overview", mounts: "folders", "device-adder": "devices", admin: "server" };

export class ObsiSettingTab extends PluginSettingTab {
  private active: SectionId = "overview";
  private state = initialState();
  private cleanups: Array<() => void> = [];

  constructor(
    app: App,
    private plugin: ObsiSyncPlugin
  ) {
    super(app, plugin);
  }

  /** The shared rules file changed. Drop the cached copy and redraw the tabs that show it. */
  noteRulesChanged() {
    if (!this.state.rulesDirty) this.state.rulesDraft = undefined;
    if ((this.active === "ai" || this.active === "overview") && this.containerEl.isConnected) this.display();
  }

  /** section shown on the next display() */
  selectSection(id: string) {
    this.active = ALIASES[id] ?? (SECTIONS.some((s) => s.id === id) ? (id as SectionId) : "overview");
  }

  hide() {
    this.cleanup();
    // secrets are never left on screen once the page is closed
    this.state.qrVisible = false;
    this.state.newDevice = undefined;
    this.state.connectionEditing = false;
    // unsaved rule edits are dropped with the page
    this.state.rulesDraft = undefined;
    this.state.rulesDirty = false;
  }

  display(): void {
    this.cleanup();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("obsi-sync-settings");
    if (this.active === "dev" && !this.state.devUnlocked) this.active = "overview";

    const ctx: SettingsContext = {
      app: this.app,
      plugin: this.plugin,
      state: this.state,
      save: async () => {
        await this.plugin.saveSettings();
        this.plugin.updateStatus();
      },
      refresh: () => this.display(),
      go: (id) => {
        if (this.active !== id) {
          this.state.qrVisible = false;
          this.state.newDevice = undefined;
          this.state.editingMount = undefined;
        }
        this.active = id;
        this.display();
        this.containerEl.scrollTop = 0;
      },
      onCleanup: (fn) => this.cleanups.push(fn),
    };

    const nav = containerEl.createDiv({ cls: "obsi-sync-nav", attr: { role: "tablist", "aria-label": tr("Settings sections") } });
    const visible = SECTIONS.filter((s) => s.id !== "dev" || this.state.devUnlocked);
    for (const s of visible) {
      const selected = s.id === this.active;
      const b = nav.createEl("button", { cls: "obsi-sync-nav-item", attr: { role: "tab", "aria-selected": String(selected), id: `obsi-sync-tab-${s.id}` } });
      b.type = "button";
      b.tabIndex = selected ? 0 : -1;
      setIcon(b.createSpan({ cls: "obsi-sync-nav-icon" }), s.icon);
      b.createSpan({ text: tr(s.label) });
      b.addEventListener("click", () => ctx.go(s.id));
      b.addEventListener("keydown", (event) => {
        const i = visible.indexOf(s);
        let next = -1;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (i + 1) % visible.length;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (i + visible.length - 1) % visible.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = visible.length - 1;
        if (next < 0) return;
        event.preventDefault();
        ctx.go(visible[next].id);
        containerEl.querySelector<HTMLButtonElement>(`#obsi-sync-tab-${visible[next].id}`)?.focus();
      });
    }
    // the Overview summarizes AI access from the cached rules; load them once
    if (this.plugin.rules.peek() === undefined) void this.plugin.rules.load(true).then(() => this.containerEl.isConnected && this.display());
    const panel = containerEl.createDiv({ cls: "obsi-sync-page", attr: { role: "tabpanel", "aria-labelledby": `obsi-sync-tab-${this.active}` } });
    (SECTIONS.find((s) => s.id === this.active) ?? SECTIONS[0]).render(ctx, panel);
  }

  private cleanup() {
    for (const fn of this.cleanups.splice(0)) fn();
  }
}
