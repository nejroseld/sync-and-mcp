import { Notice, Plugin, TFile } from "obsidian";
import { ChangesApplier } from "./ai/applier";
import { registerNewNoteProps } from "./ai/newNoteProps";
import { AiPublisher } from "./ai/publisher";
import { RULES_FILE_PATH } from "./ai/rules";
import { RulesStore } from "./ai/rulesStore";
import { ObsiApi } from "./api/client";
import { obsidianHttp } from "./api/httpObsidian";
import type { MeInfo, VaultInfo } from "./api/types";
import { t } from "./i18n";
import { DEFAULT_SETTINGS, type ObsiSettings, isConfigured, normalizeSettings } from "./settings";
import { SyncManager } from "./syncManager";
import { findOwningMount } from "./sync/mounts";
import { SetupModal } from "./ui/setupModal";
import { ObsiSettingTab } from "./ui/settingsTab";

export default class ObsiSyncPlugin extends Plugin {
  settings: ObsiSettings = { ...DEFAULT_SETTINGS };
  rules!: RulesStore;
  publisher!: AiPublisher;
  applier!: ChangesApplier;
  syncManager!: SyncManager;
  me: MeInfo | undefined;
  vaults: VaultInfo[] = [];
  private statusEl: HTMLElement | undefined;
  private intervalIds: number[] = [];
  private saveSyncTimer: number | undefined;

  async onload() {
    await this.loadSettings();
    this.rules = new RulesStore(this.app);

    const host = {
      app: this.app,
      settings: this.settings,
      rules: this.rules,
      getApi: () => this.getApi(),
      writableVaults: () => this.writableVaults(),
    };
    this.publisher = new AiPublisher(host);
    this.applier = new ChangesApplier({
      ...host,
      isSyncRunning: () => this.syncManager.running,
    });
    this.syncManager = new SyncManager({
      app: this.app,
      settings: this.settings,
      pluginId: this.manifest.id,
      getApi: () => this.getApi(),
      setStatus: (t) => this.setStatus(t),
      onSyncFinished: () => void this.afterSync(),
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onClickEvent(() => {
      if (!isConfigured(this.settings)) this.openSetup();
    });
    this.updateStatus();

    // until the plugin is set up, every entry point leads to the setup window instead of an error
    const syncNow = () => {
      if (isConfigured(this.settings)) void this.syncManager.syncAll("manual");
      else this.openSetup();
    };
    this.addRibbonIcon("refresh-cw", t("Obsi Sync: sync now"), syncNow);
    this.addCommand({ id: "sync-now", name: t("Sync now"), callback: syncNow });
    this.addCommand({ id: "set-up", name: t("Set up"), callback: () => this.openSetup() });
    this.addCommand({
      id: "publish-ai",
      name: t("Publish AI Available now"),
      callback: async () => {
        const r = await this.publisher.runNow();
        new Notice(r.skipped ? `Obsi Sync: ${r.skipped}` : t("Obsi Sync: AI Available published"));
      },
    });
    this.addCommand({
      id: "apply-changes",
      name: t("Apply pending MCP changes now"),
      callback: async () => {
        const r = await this.applier.runNow();
        new Notice(
          r.skipped
            ? `Obsi Sync: ${r.skipped}`
            : t("Obsi Sync: applied {applied}, conflicts {conflicts}, rejected {rejected}", {
                applied: r.applied, conflicts: r.conflicts, rejected: r.rejected,
              })
        );
      },
    });

    this.addSettingTab(new ObsiSettingTab(this.app, this));

    // AI publish triggers (debounced inside the publisher)
    const poke = () => this.publisher.schedule();
    this.app.workspace.onLayoutReady(() => {
      // create events fire for every file while the vault is loading; register afterwards
      this.registerEvent(this.app.vault.on("create", (file) => {
        poke();
        if (file instanceof TFile) this.scheduleSaveSync(file.path);
      }));
      this.registerEvent(this.app.vault.on("modify", (file) => {
        poke();
        if (file instanceof TFile) this.scheduleSaveSync(file.path);
      }));
      this.registerEvent(this.app.vault.on("delete", poke));
      this.registerEvent(this.app.vault.on("rename", poke));
      this.registerEvent(this.app.metadataCache.on("changed", (f: TFile) => poke()));
      this.registerEvent(
        this.app.vault.on("raw" as any, (p: any) => {
          if (p === RULES_FILE_PATH) void this.rules.reload();
        })
      );
      this.rules.onChange(poke);
      registerNewNoteProps(this.app, this.rules, (ref) => this.registerEvent(ref));

      if (!this.settings.onboardingDone && !isConfigured(this.settings)) {
        this.openSetup();
        return;
      }

      void this.refreshMe();
      if (this.settings.syncEnabled && this.settings.syncOnStartup) {
        window.setTimeout(
          () => void this.syncManager.syncAll("auto_once_init"),
          Math.max(1, this.settings.startupDelaySeconds) * 1000
        );
      } else {
        this.publisher.schedule();
      }
    });
    this.restartTimers();
  }

  onunload() {
    this.publisher?.stop();
    if (this.saveSyncTimer !== undefined) window.clearTimeout(this.saveSyncTimer);
    for (const id of this.intervalIds) window.clearInterval(id);
  }

  /** Obsidian emits several modify events for one edit; sync after writes settle. */
  private scheduleSaveSync(path: string) {
    const s = this.settings;
    if (!s.syncEnabled || !s.syncOnSave || this.syncManager.running) return;
    if (!isConfigured(s) || !findOwningMount(path, s.mounts)) return;
    if (this.saveSyncTimer !== undefined) window.clearTimeout(this.saveSyncTimer);
    this.saveSyncTimer = window.setTimeout(() => {
      this.saveSyncTimer = undefined;
      if (s.syncEnabled && s.syncOnSave && !this.syncManager.running) {
        void this.syncManager.syncAll("auto_sync_on_save");
      }
    }, 1500);
  }

  restartTimers() {
    for (const id of this.intervalIds) window.clearInterval(id);
    this.intervalIds = [];
    if (this.settings.autoSyncMinutes > 0) {
      this.intervalIds.push(
        window.setInterval(
          () => void this.syncManager.syncAll("auto"),
          this.settings.autoSyncMinutes * 60_000
        )
      );
    }
    if (this.settings.changesPollMinutes > 0) {
      this.intervalIds.push(
        window.setInterval(
          () => void this.applier.runNow().catch(console.error),
          this.settings.changesPollMinutes * 60_000
        )
      );
    }
    for (const id of this.intervalIds) this.registerInterval(id);
  }

  private async afterSync() {
    try {
      await this.rules.reload();
      await this.refreshMe();
      await this.applier.runNow();
      await this.publisher.runNow();
    } catch (e) {
      console.warn("obsi-sync: post-sync tasks failed", e);
    }
  }

  openSetup() {
    new SetupModal(this.app, this).open();
  }

  /** idle status line; "set up" while there is nothing to sync */
  updateStatus() {
    this.setStatus(t(isConfigured(this.settings) ? "Obsi: idle" : "Obsi: set up"));
  }

  setStatus(text: string) {
    if (!this.settings.statusBar) {
      this.statusEl?.setText("");
      return;
    }
    this.statusEl?.setText(text);
  }

  getApi(): ObsiApi | undefined {
    if (!this.settings.serverUrl || !this.settings.deviceToken) return undefined;
    return new ObsiApi(this.settings.serverUrl, this.settings.deviceToken, obsidianHttp);
  }

  getAdminApi(): ObsiApi | undefined {
    if (!this.settings.serverUrl || !this.settings.adminToken) return undefined;
    return new ObsiApi(this.settings.serverUrl, this.settings.adminToken, obsidianHttp);
  }

  /** vault ids with a write grant for this device token; undefined if unknown (offline) */
  writableVaults(): Set<string> | undefined {
    if (!this.me) return undefined;
    const res = new Set<string>();
    for (const [vid, ops] of Object.entries(this.me.grants ?? {})) {
      if (ops.includes("write")) res.add(vid);
    }
    return res;
  }

  async refreshMe() {
    const api = this.getApi();
    if (!api) return;
    try {
      this.me = await api.me();
      this.vaults = await api.listVaults();
    } catch (e) {
      // offline or bad token: keep whatever we knew
      console.debug("obsi-sync: refreshMe failed", e);
    }
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    // keep the same object identity for hosts that captured it
    await this.saveData(this.settings);
    this.restartTimers();
  }
}
