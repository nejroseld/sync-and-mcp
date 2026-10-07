import { type App, TFile, parseYaml } from "obsidian";
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
import { extractFrontmatterText } from "./changes";
import { computeAllowedPaths, decisionHoldRemainingMs, defaultRegistry, evaluateNote, type RulesConfig } from "./rules";
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
  /** Fires when a new note's private-checkbox pause ends, so it publishes without another edit. */
  private holdTimer: number | undefined;
  private running = false;
  private again = false;
  last: PublishReport | undefined;

  constructor(private host: PublisherHost) {}

  /** debounced */
  schedule() {
    if (!this.host.settings.aiEnabled) return;
    // A change during a publish (for example ticking private) must revoke in this pass,
    // not after another debounce, or the plaintext put can land first and be indexed.
    if (this.running) this.again = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.runNow();
    }, Math.max(1, this.host.settings.aiDebounceSeconds) * 1000);
  }

  stop() {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.armHoldRelease(undefined);
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
      console.error("sync-and-mcp: publish failed", e);
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
    const snapshot = takeSnapshot(app);
    const holdMs = this.privateHoldMs();
    const allowed = computeAllowedPaths(parsed.config, snapshot, defaultRegistry(), holdMs);
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
        const rejected = new Set<string>();
        for (const item of desired) {
          if (item.kind !== "note") continue;
          const f = fileByRel.get(item.relPath);
          if (!f) {
            rejected.add(item.vaultPath);
            continue;
          }
          try {
            if (!this.noteBytesAllowed(parsed.config, f, await app.vault.readBinary(f))) {
              rejected.add(item.vaultPath);
            }
          } catch {
            rejected.add(item.vaultPath);
          }
        }
        const fresh = desired.filter((item) => item.kind !== "note" || !rejected.has(item.vaultPath));
        const manifest = await api.aiManifest(m.vaultId);
        const diff = computePublishDiff(fresh, manifest);
        for (const d of diff.put) {
          const f = fileByRel.get(d.relPath)!;
          const content = await app.vault.readBinary(f);
          if (d.kind === "note" && !this.noteBytesAllowed(parsed.config, f, content)) {
            await api.aiDelete(m.vaultId, d.relPath);
            row.deleted++;
            continue;
          }
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
    this.armHoldRelease(decisionHoldRemainingMs(parsed.config, snapshot, holdMs));
    return report;
  }

  /** 0 shares a new note immediately; otherwise minutes from this device's setting. */
  private privateHoldMs(): number {
    const minutes = this.host.settings.aiPrivateHoldMinutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return 0;
    return minutes * 60_000;
  }

  private armHoldRelease(waitMs: number | undefined) {
    if (this.holdTimer !== undefined) window.clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    if (waitMs === undefined || !(waitMs > 0) || !this.host.settings.aiEnabled) return;
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = undefined;
      void this.runNow();
    }, Math.max(250, Math.ceil(waitMs) + 500));
  }

  /** Frontmatter is read from these bytes, not the metadata cache, so a just-ticked private note is not uploaded. */
  private noteBytesAllowed(config: RulesConfig, f: TFile, bytes: ArrayBuffer): boolean {
    const raw = extractFrontmatterText(new TextDecoder().decode(bytes));
    let fm: Record<string, unknown> | undefined;
    if (raw !== undefined) {
      try {
        const v = parseYaml(raw);
        if (!v || typeof v !== "object" || Array.isArray(v)) return false;
        fm = v as Record<string, unknown>;
      } catch {
        return false;
      }
    }
    const tags = this.host.app.metadataCache.getFileCache(f)?.tags?.map((t) => t.tag);
    return evaluateNote(
      config,
      defaultRegistry(),
      {
        path: f.path,
        frontmatter: fm,
        inlineTags: tags,
        ctime: f.stat.ctime,
        now: Date.now(),
      },
      this.privateHoldMs()
    );
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
