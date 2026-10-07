import { Menu, setIcon } from "obsidian";
import { t as tr } from "../i18n";
import { isConfigured } from "../settings";
import type ObsiSyncPlugin from "../main";
import { relativeTime } from "./kit";

export type SyncState = "setup" | "paused" | "syncing" | "error" | "synced" | "idle";

/** One place that decides how the overall sync state is presented (status bar, settings overview). */
export const syncState = (plugin: ObsiSyncPlugin): SyncState => {
  const s = plugin.settings;
  if (!isConfigured(s)) return "setup";
  if (plugin.syncManager.running) return "syncing";
  if (!s.syncEnabled) return "paused";
  if (plugin.syncManager.failures().length > 0) return "error";
  return plugin.syncManager.lastRunAt ? "synced" : "idle";
};

export const STATE_ICON: Record<SyncState, string> = {
  setup: "settings",
  paused: "pause-circle",
  syncing: "refresh-cw",
  error: "alert-triangle",
  synced: "check-circle",
  idle: "cloud",
};

/** Short status-bar text, e.g. "Synced 3 min ago". */
export const stateLabel = (plugin: ObsiSyncPlugin, state = syncState(plugin)): string => {
  switch (state) {
    case "setup": return tr("Sync and MCP: set up");
    case "paused": return tr("Sync paused");
    case "syncing": return tr("Syncing...");
    case "error": return tr("Sync problem");
    case "synced": return tr("Synced {time}", { time: relativeTime(plugin.syncManager.lastRunAt) });
    case "idle": return tr("Sync and MCP");
  }
};

/**
 * Status bar item: icon + short state. Click opens the welcome window until set up,
 * otherwise a small menu (sync now, pause/resume, settings).
 */
export class StatusBar {
  private iconEl: HTMLElement;
  private textEl: HTMLElement;
  private liveText: string | undefined;

  constructor(
    private el: HTMLElement,
    private plugin: ObsiSyncPlugin
  ) {
    el.addClass("mod-clickable", "obsi-sync-statusbar");
    this.iconEl = el.createSpan({ cls: "obsi-sync-statusbar-icon" });
    this.textEl = el.createSpan({ cls: "obsi-sync-statusbar-text" });
    el.addEventListener("click", (e) => this.onClick(e));
  }

  /** `live` is the engine's progress text while a sync is running */
  update(live?: string) {
    const s = this.plugin.settings;
    this.el.toggle(s.statusBar);
    if (!s.statusBar) return;
    const state = syncState(this.plugin);
    this.liveText = state === "syncing" ? live ?? this.liveText : undefined;
    this.el.dataset.state = state;
    setIcon(this.iconEl, STATE_ICON[state]);
    this.textEl.setText(state === "syncing" && this.liveText ? this.liveText : stateLabel(this.plugin, state));
    const failures = this.plugin.syncManager.failures();
    const tip =
      state === "error"
        ? failures.map((f) => `${f.path || tr("Whole vault")}: ${f.lastError}`).join("\n")
        : state === "setup"
          ? tr("Click to set up Sync and MCP")
          : tr("Sync and MCP: click for actions");
    this.el.setAttribute("aria-label", tip);
    this.el.setAttribute("data-tooltip-position", "top");
  }

  private onClick(e: MouseEvent) {
    const p = this.plugin;
    if (!isConfigured(p.settings)) {
      p.openSetup();
      return;
    }
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle(tr("Sync now")).setIcon("refresh-cw").setDisabled(p.syncManager.running || !p.settings.syncEnabled).onClick(() => void p.syncManager.syncAll("manual"))
    );
    menu.addItem((i) =>
      i
        .setTitle(p.settings.syncEnabled ? tr("Pause sync") : tr("Resume sync"))
        .setIcon(p.settings.syncEnabled ? "pause" : "play")
        .onClick(() => void p.setSyncEnabled(!p.settings.syncEnabled))
    );
    menu.addSeparator();
    if (syncState(p) === "error") {
      menu.addItem((i) => i.setTitle(tr("Show sync problems")).setIcon("alert-triangle").onClick(() => p.openSettings("overview")));
    }
    menu.addItem((i) => i.setTitle(tr("Add another device")).setIcon("smartphone").onClick(() => p.openSettings("devices")));
    menu.addItem((i) => i.setTitle(tr("Sync and MCP settings")).setIcon("settings").onClick(() => p.openSettings()));
    menu.showAtMouseEvent(e);
  }
}
