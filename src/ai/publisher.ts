import { type App, TFile } from "obsidian";
import { ApiError, type ObsiApi } from "../api/client";
import type { MountConfig, ObsiSettings } from "../settings";
import { normalizeMountPath } from "../sync/mounts";
import {
  type DesiredFile,
  computePublishDiff,
  groupAllowedByMount,
  kindOf,
  relPathFor,
  sha256Hex,
} from "./publish";
import { computeAllowedPaths } from "./rules";
import type { RulesStore } from "./rulesStore";
import { takeSnapshot } from "./vaultSnapshot";

export interface PublisherHost {
  app: App;
  settings: ObsiSettings;
  rules: RulesStore;
  getApi(): ObsiApi | undefined;
  /** vault ids the device token may write to; undefined = unknown, try everything */
  writableVaults(): Set<string> | undefined;
  setStatus?(text: string): void;
}

export interface PublishReport {
  skipped?: string;
  perVault: { vaultId: string; put: number; deleted: number; stale: number; error?: string }[];
}

/**
 * Publishes the AI Available set of every mounted vault (plaintext) to the server.
 * Only runs when enabled, a root mount exists and `.obsi/ai-rules.json` is present and valid.
 */
export class AiPublisher {
  private hashCache = new Map<string, { mtime: number; size: number; hash: string }>();
  private timer: number | undefined;
  private running = false;
  private again = false;
  last: PublishReport | undefined;

  constructor(private host: PublisherHost) {}

  /** debounced */
  schedule() {
    if (!this.host.settings.aiEnabled) return;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.runNow();
    }, Math.max(1, this.host.settings.aiDebounceSeconds) * 1000);
  }

  stop() {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  async runNow(): Promise<PublishReport> {
    if (this.running) {
      this.again = true;
      return this.last ?? { skipped: "busy", perVault: [] };
    }
    this.running = true;
    try {
      do {
        this.again = false;
        this.last = await this.publish();
      } while (this.again);
      return this.last;
    } catch (e) {
      console.error("obsi-sync: publish failed", e);
      this.last = { skipped: String(e), perVault: [] };
      return this.last;
    } finally {
      this.running = false;
    }
  }

  private async publish(): Promise<PublishReport> {
    const s = this.host.settings;
    if (!s.aiEnabled) return { skipped: "AI Available is disabled", perVault: [] };
    const api = this.host.getApi();
    if (!api) return { skipped: "server is not configured", perVault: [] };
    const mounts = s.mounts.filter((m) => m.vaultId !== "");
    if (!mounts.some((m) => normalizeMountPath(m.path) === "")) {
      return { skipped: "no root mount: this device does not publish", perVault: [] };
    }
    const parsed = await this.host.rules.load(true);
    if (parsed === null) {
      return { skipped: "no .obsi/ai-rules.json: this device does not publish", perVault: [] };
    }
    if (parsed.errors.length > 0) {
      return { skipped: `rules file has errors: ${parsed.errors.join("; ")}`, perVault: [] };
    }

    const app = this.host.app;
    const allowed = computeAllowedPaths(parsed.config, takeSnapshot(app));
    const grouped = groupAllowedByMount(allowed, mounts);
    const writable = this.host.writableVaults();
    const maxBytes = s.aiMaxFileMB * 1024 * 1024;
    const report: PublishReport = { perVault: [] };

    for (const m of mounts) {
      if (writable !== undefined && !writable.has(m.vaultId)) continue;
      const row = { vaultId: m.vaultId, put: 0, deleted: 0, stale: 0 } as PublishReport["perVault"][number];
      report.perVault.push(row);
      try {
        const desired: DesiredFile[] = [];
        const fileByRel = new Map<string, TFile>();
        for (const vp of grouped.get(m) ?? []) {
          const f = app.vault.getAbstractFileByPath(vp);
          if (!(f instanceof TFile)) continue;
          if (f.stat.size > maxBytes) continue;
          const rel = relPathFor(vp, m.path);
          if (rel === undefined) continue;
          const hash = await this.hashOf(f);
          desired.push({
            relPath: rel,
            vaultPath: vp,
            version: hash,
            mtime: f.stat.mtime,
            size: f.stat.size,
            kind: kindOf(vp),
          });
          fileByRel.set(rel, f);
        }
        const manifest = await api.aiManifest(m.vaultId);
        const diff = computePublishDiff(desired, manifest);
        for (const d of diff.put) {
          const f = fileByRel.get(d.relPath)!;
          const content = await app.vault.readBinary(f);
          const res = await api.aiPut(m.vaultId, d.relPath, content, f.stat.mtime);
          if (res === "stale") row.stale++;
          else row.put++;
        }
        for (const p of diff.del) {
          await api.aiDelete(m.vaultId, p);
          row.deleted++;
        }
      } catch (e) {
        row.error = e instanceof ApiError ? e.message : String(e);
      }
    }
    return report;
  }

  private async hashOf(f: TFile): Promise<string> {
    const c = this.hashCache.get(f.path);
    if (c && c.mtime === f.stat.mtime && c.size === f.stat.size) return c.hash;
    const hash = await sha256Hex(await this.host.app.vault.readBinary(f));
    this.hashCache.set(f.path, { mtime: f.stat.mtime, size: f.stat.size, hash });
    return hash;
  }

  /** "AI Available" switched off: wipe what was published (button in settings) */
  async clearPublished(mounts: MountConfig[]): Promise<string[]> {
    const api = this.host.getApi();
    if (!api) throw Error("server is not configured");
    const errors: string[] = [];
    for (const m of mounts) {
      if (m.vaultId === "") continue;
      try {
        await api.aiClear(m.vaultId);
      } catch (e) {
        errors.push(`${m.vaultId}: ${e}`);
      }
    }
    return errors;
  }
}
