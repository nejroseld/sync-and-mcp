import { type App, TFile, parseYaml } from "obsidian";
import type { ObsiApi } from "../api/client";
import type { PendingChange } from "../api/types";
import type { ObsiSettings } from "../settings";
import { mkdirpInVault } from "../sync/misc";
import { findOwningMount, toVaultPath } from "../sync/mounts";
import { decideChange, extractFrontmatterText } from "./changes";
import { sha256Hex } from "./publish";
import { evaluateNote, defaultRegistry, type RulesConfig } from "./rules";
import type { RulesStore } from "./rulesStore";

export interface ApplierHost {
  app: App;
  settings: ObsiSettings;
  rules: RulesStore;
  getApi(): ObsiApi | undefined;
  writableVaults(): Set<string> | undefined;
  isSyncRunning(): boolean;
}

export interface ApplyReport {
  skipped?: string;
  applied: number;
  conflicts: number;
  rejected: number;
  errors: string[];
}

export interface PendingPreviewItem {
  vaultId: string;
  vaultName: string;
  id: string;
  path: string;
  op: PendingChange["op"];
  author?: string;
  excerpt: string;
}

export interface PendingPreview {
  skipped?: string;
  items: PendingPreviewItem[];
  errors: string[];
}

/** A short slice of the note text for the on-demand preview. Not a diff and not stored. */
export const changeExcerpt = (content: string): string => {
  const lines = content.split(/\r?\n/);
  let text = lines.slice(0, 12).join("\n");
  if (text.length > 600) text = `${text.slice(0, 600)}…`;
  else if (lines.length > 12) text = `${text}\n…`;
  return text;
};

/** `parseYaml` is typed as `any`; this only erases that so the result is checked below. */
const readYaml = (text: string): unknown => parseYaml(text) as unknown;

// A YAML sequence is a non-null object and was already treated as frontmatter.
const isFrontmatter = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const parseFm = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  try {
    const v = readYaml(text);
    return isFrontmatter(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

/** Applies pending MCP changes (write_note) to the local vault and acks them. */
export class ChangesApplier {
  private running = false;
  constructor(private host: ApplierHost) {}

  /**
   * One read of the pending queue. No timer and no writes: the caller opens this
   * when they want to see what an assistant wrote.
   */
  async listPending(): Promise<PendingPreview> {
    const rep: PendingPreview = { items: [], errors: [] };
    const api = this.host.getApi();
    if (!api) {
      rep.skipped = "server not configured";
      return rep;
    }
    const mounts = this.host.settings.mounts.filter((m) => m.vaultId !== "");
    for (const m of mounts) {
      let changes: PendingChange[];
      try {
        changes = await api.pendingChanges(m.vaultId);
      } catch (e) {
        rep.errors.push(`${m.vaultName || m.vaultId}: ${e}`);
        continue;
      }
      for (const c of changes) {
        rep.items.push({
          vaultId: m.vaultId,
          vaultName: m.vaultName || m.path || m.vaultId,
          id: c.id,
          path: c.path,
          op: c.op,
          author: c.token_name,
          excerpt: changeExcerpt(c.content),
        });
      }
    }
    return rep;
  }

  async runNow(): Promise<ApplyReport> {
    const rep: ApplyReport = { applied: 0, conflicts: 0, rejected: 0, errors: [] };
    const s = this.host.settings;
    if (this.running || this.host.isSyncRunning()) {
      rep.skipped = "busy";
      return rep;
    }
    const api = this.host.getApi();
    if (!api || !s.aiEnabled) {
      rep.skipped = "AI Available disabled or server not configured";
      return rep;
    }
    const parsed = await this.host.rules.load(true);
    if (parsed === null || parsed.errors.length > 0) {
      rep.skipped = "no valid .obsi/ai-rules.json";
      return rep;
    }
    this.running = true;
    try {
      const writable = this.host.writableVaults();
      const mounts = s.mounts.filter((m) => m.vaultId !== "");
      for (const m of mounts) {
        if (writable !== undefined && !writable.has(m.vaultId)) continue;
        let changes: PendingChange[];
        try {
          changes = await api.pendingChanges(m.vaultId);
        } catch (e) {
          rep.errors.push(`${m.vaultId}: ${e}`);
          continue;
        }
        for (const c of changes) {
          try {
            await this.applyOne(api, m.vaultId, m.path, mounts, parsed.config, c, rep);
          } catch (e) {
            rep.errors.push(`${c.id}: ${e}`);
          }
        }
      }
    } finally {
      this.running = false;
    }
    return rep;
  }

  private async applyOne(
    api: ObsiApi,
    vaultId: string,
    mountPath: string,
    mounts: { path: string; vaultId: string }[],
    rules: RulesConfig,
    c: PendingChange,
    rep: ApplyReport
  ) {
    const app = this.host.app;
    const vaultPath = toVaultPath(c.path, mountPath);
    const owner = findOwningMount(vaultPath, mounts);
    const owned = owner !== undefined && owner.vaultId === vaultId;
    const existing = app.vault.getAbstractFileByPath(vaultPath);
    const file = existing instanceof TFile ? existing : undefined;

    let sha: string | undefined;
    if (file) sha = await sha256Hex(await app.vault.readBinary(file));

    // allowed now (current state) and after the change (new frontmatter)
    const registry = defaultRegistry();
    const newFm = parseFm(extractFrontmatterText(c.content));
    const curFm = file ? app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const allowedNew = evaluateNote(rules, registry, { path: vaultPath, frontmatter: newFm });
    const allowedCur = file
      ? evaluateNote(rules, registry, { path: vaultPath, frontmatter: curFm })
      : true;

    const decision = decideChange({
      change: c,
      local: { exists: file !== undefined, sha },
      allowed: allowedNew && allowedCur,
      ownedByThisVault: owned,
    });

    if (decision.action === "ack_only") {
      await api.ackChange(vaultId, c.id, decision.status, decision.message);
      if (decision.status === "conflict") rep.conflicts++;
      else rep.rejected++;
      return;
    }
    if (c.op === "create") {
      await mkdirpInVault(vaultPath, app.vault.adapter);
      await app.vault.create(vaultPath, c.content);
    } else {
      await app.vault.modify(file!, c.content);
    }
    const newVersion = await sha256Hex(new TextEncoder().encode(c.content));
    await api.ackChange(vaultId, c.id, "applied", undefined, newVersion);
    rep.applied++;
  }
}

