import { type App, Notice } from "obsidian";
import type { ObsiApi } from "./api/client";
import { t } from "./i18n";
import type { ObsiSettings } from "./settings";
import { validateMounts } from "./settings";
import type { SyncTriggerSourceType } from "./sync/baseTypes";
import { FakeFsLocal } from "./sync/fsLocal";
import { normalizeMountPath } from "./sync/mounts";
import { LocalForagePrevSyncStore } from "./sync/prevSyncDb";
import { ownPluginDataIgnorePattern, runMountSync } from "./sync/runMount";
import type { SyncSettings } from "./sync/sync";

export interface MountStatus {
  vaultId: string;
  path: string;
  lastRun?: number;
  lastOk?: number;
  lastError?: string;
  progress?: string;
}

export interface SyncProgress {
  done: number;
  total: number;
}
export type SyncListener = (text: string, progress?: SyncProgress) => void;

export interface SyncHost {
  app: App;
  settings: ObsiSettings;
  pluginId: string;
  getApi(): ObsiApi | undefined;
  setStatus(text: string): void;
  onSyncFinished(allOk: boolean): void;
}

/**
 * Runs the forked syncer for every mount, one after another and independently:
 * a failing (e.g. offline) mount does not stop the others and is simply retried next time.
 */
export class SyncManager {
  running = false;
  status = new Map<string, MountStatus>();
  /** end of the last finished run in this session */
  lastRunAt: number | undefined;
  private listeners = new Set<SyncListener>();
  private db: LocalForagePrevSyncStore;

  constructor(private host: SyncHost) {
    const appId = (host.app as any).appId ?? host.app.vault.getName();
    this.db = new LocalForagePrevSyncStore(`obsi-sync/${appId}`);
  }

  /** live status for the status bar, settings and the welcome window; returns an unsubscribe function */
  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** mounts whose last run failed */
  failures(): MountStatus[] {
    return [...this.status.values()].filter((x) => x.lastError);
  }

  private report(text: string, progress?: SyncProgress) {
    this.host.setStatus(text);
    for (const l of this.listeners) l(text, progress);
  }

  async clearHistory(vaultId: string) {
    await this.db.clearAll(vaultId);
  }

  async syncAll(trigger: SyncTriggerSourceType = "manual"): Promise<boolean> {
    const s = this.host.settings;
    if (this.running) {
      if (trigger === "manual") new Notice(t("Obsi Sync: sync already running"));
      return false;
    }
    if (!s.syncEnabled) {
      if (trigger === "manual") new Notice(t("Obsi Sync: sync is disabled in settings"));
      return false;
    }
    const api = this.host.getApi();
    if (!api) {
      if (trigger === "manual") new Notice(t("Obsi Sync: set server URL and device token first"));
      return false;
    }
    const problems = validateMounts(s.mounts);
    if (problems.length > 0) {
      if (trigger === "manual") new Notice(`Obsi Sync: ${problems.join("; ")}`);
      return false;
    }
    const mounts = s.mounts.filter((m) => m.vaultId !== "");
    if (mounts.length === 0) {
      if (trigger === "manual") new Notice(t("Obsi Sync: no mounts configured"));
      return false;
    }

    this.running = true;
    let allOk = true;
    const allPaths = mounts.map((m) => m.path);
    // deepest mounts first, so a nested vault is done before its parent
    const ordered = [...mounts].sort(
      (a, b) => normalizeMountPath(b.path).length - normalizeMountPath(a.path).length
    );
    try {
      for (const m of ordered) {
        const label = m.vaultName ?? m.vaultId;
        const st: MountStatus = this.status.get(m.vaultId) ?? { vaultId: m.vaultId, path: m.path };
        st.path = m.path;
        st.lastRun = Date.now();
        this.status.set(m.vaultId, st);
        this.report(t("Obsi: syncing {vault}", { vault: label }));

        if (m.password === "") {
          st.lastError = "no password set for this mount";
          allOk = false;
          continue;
        }
        const isRoot = normalizeMountPath(m.path) === "";
        const configDir = this.host.app.vault.configDir;
        const fsLocal = new FakeFsLocal(
          this.host.app.vault,
          isRoot && s.syncConfigDir,
          configDir,
          this.host.pluginId,
          s.deleteToWhere,
          isRoot ? [".obsi"] : []
        );
        const settings: SyncSettings = {
          concurrency: s.concurrency,
          syncConfigDir: isRoot && s.syncConfigDir,
          allowedHiddenDirs: isRoot ? [".obsi"] : [],
          conflictAction: s.conflictAction,
          syncDirection: "bidirectional",
          howToCleanEmptyFolder: "clean_both",
          protectModifyPercentage: s.protectModifyPercentage,
          skipSizeLargerThan: -1,
          ignorePaths: [ownPluginDataIgnorePattern(configDir, this.host.pluginId)],
        };
        const res = await runMountSync({
          api,
          vaultId: m.vaultId,
          mountPath: m.path,
          allMountPaths: allPaths,
          password: m.password,
          method: m.encryptionMethod,
          fsLocalWhole: fsLocal,
          db: this.db,
          settings,
          configDir,
          trigger,
          progress: (step, info) => {
            if (info?.total) {
              const done = info.done ?? 0;
              this.report(t("Obsi: {vault} {done}/{total}", { vault: label, done, total: info.total }), { done, total: info.total });
            }
          },
        });
        if (res.ok) {
          st.lastOk = Date.now();
          st.lastError = undefined;
        } else {
          allOk = false;
          st.lastError = res.error?.message ?? "unknown error";
          console.warn(`obsi-sync: sync of ${label} failed:`, res.error);
        }
      }
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
    }
    this.report(t(allOk ? "Obsi: synced" : "Obsi: sync problem (will retry)"));
    if (!allOk && trigger === "manual") {
      const errs = [...this.status.values()].filter((x) => x.lastError).map((x) => `${x.path || "/"}: ${x.lastError}`);
      new Notice(t("Obsi Sync failed: {errors}", { errors: errs.join("; ") }), 8000);
    } else if (trigger === "manual") {
      new Notice(t("Obsi Sync: done"));
    }
    this.host.onSyncFinished(allOk);
    return allOk;
  }
}
