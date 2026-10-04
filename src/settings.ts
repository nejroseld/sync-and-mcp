import type { CipherMethodType, ConflictActionType } from "./sync/baseTypes";
import { normalizeMountPath } from "./sync/mounts";

export interface MountConfig {
  /** folder in the vault, "" = vault root */
  path: string;
  vaultId: string;
  vaultName?: string;
  /** E2EE password, stored only on this device */
  password: string;
  encryptionMethod: CipherMethodType;
}

export interface ObsiSettings {
  serverUrl: string;
  /** device token (kind=device) used for sync / publishing / applying changes */
  deviceToken: string;
  /** optional admin token, only used by the settings UI to manage vaults/tokens */
  adminToken: string;

  syncEnabled: boolean;
  syncOnStartup: boolean;
  syncOnSave: boolean;
  startupDelaySeconds: number;
  /** 0 = off */
  autoSyncMinutes: number;
  conflictAction: ConflictActionType;
  syncConfigDir: boolean;
  concurrency: number;
  /** abort a sync that would modify/delete >= this percent of files (needs >= 10 files). -1 = off */
  protectModifyPercentage: number;
  deleteToWhere: "obsidian" | "system";
  mounts: MountConfig[];

  aiEnabled: boolean;
  aiDebounceSeconds: number;
  aiMaxFileMB: number;
  changesPollMinutes: number;
  statusBar: boolean;
  /** the welcome window was shown (answered or skipped) */
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: ObsiSettings = {
  serverUrl: "",
  deviceToken: "",
  adminToken: "",
  syncEnabled: true,
  syncOnStartup: true,
  syncOnSave: true,
  startupDelaySeconds: 5,
  autoSyncMinutes: 5,
  conflictAction: "keep_newer",
  syncConfigDir: false,
  concurrency: 3,
  protectModifyPercentage: 50,
  deleteToWhere: "obsidian",
  mounts: [],
  aiEnabled: false,
  aiDebounceSeconds: 5,
  aiMaxFileMB: 25,
  changesPollMinutes: 2,
  statusBar: true,
  onboardingDone: false,
};

/** Enough to sync: server, device token and at least one mount with a vault and a password. */
export const isConfigured = (s: ObsiSettings): boolean =>
  s.serverUrl.trim() !== "" &&
  s.deviceToken.trim() !== "" &&
  s.mounts.some((m) => m.vaultId !== "" && m.password !== "" && m.encryptionMethod === "rclone-base64");

export const normalizeSettings = (raw: any): ObsiSettings => {
  const s: ObsiSettings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  s.syncOnSave = typeof raw?.syncOnSave === "boolean" ? raw.syncOnSave : DEFAULT_SETTINGS.syncOnSave;
  s.mounts = (Array.isArray(s.mounts) ? s.mounts : []).map((m: any) => ({
    path: normalizeMountPath(String(m.path ?? "")),
    vaultId: String(m.vaultId ?? ""),
    vaultName: m.vaultName,
    password: String(m.password ?? ""),
    encryptionMethod:
      m.encryptionMethod == null || m.encryptionMethod === "rclone-base64"
        ? "rclone-base64"
        : "unknown",
  }));
  if (s.conflictAction !== "keep_larger") s.conflictAction = "keep_newer";
  // installs configured before the welcome window existed should not see it
  if (raw?.onboardingDone === undefined && isConfigured(s)) s.onboardingDone = true;
  return s;
};

const EXPORT_MARK = "obsi-sync-mounts";

/** Export of the mount layout (NO passwords, NO tokens) as a JSON string. */
export const exportMounts = (s: ObsiSettings): string =>
  JSON.stringify(
    {
      format: EXPORT_MARK,
      version: 1,
      serverUrl: s.serverUrl,
      mounts: s.mounts.map((m) => ({
        path: m.path,
        vaultId: m.vaultId,
        vaultName: m.vaultName,
        encryptionMethod: m.encryptionMethod,
      })),
    },
    null,
    2
  );

/**
 * Import: returns the mounts to add (password empty, must be filled by the user) and the server URL.
 * Throws on invalid input.
 */
export const parseMountsImport = (
  text: string
): { serverUrl?: string; mounts: MountConfig[] } => {
  const j = JSON.parse(text);
  if (j?.format !== EXPORT_MARK || !Array.isArray(j.mounts)) {
    throw Error("not an obsi-sync mounts export");
  }
  return {
    serverUrl: typeof j.serverUrl === "string" ? j.serverUrl : undefined,
    mounts: j.mounts.map((m: any) => {
      if (typeof m?.vaultId !== "string" || m.vaultId === "") {
        throw Error("mount without vaultId");
      }
      return {
        path: normalizeMountPath(String(m.path ?? "")),
        vaultId: m.vaultId,
        vaultName: m.vaultName,
        password: "",
        encryptionMethod:
          m.encryptionMethod == null || m.encryptionMethod === "rclone-base64"
            ? "rclone-base64"
            : "unknown",
      } as MountConfig;
    }),
  };
};

/** Validation of the mount list; returns human-readable problems. */
export const validateMounts = (mounts: MountConfig[]): string[] => {
  const errs: string[] = [];
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const m of mounts) {
    if (m.encryptionMethod === "unknown") {
      errs.push(`mount "${m.path || "/"}" uses an unsupported encryption method; manually migrate it to rclone before syncing`);
    }
    if (paths.has(m.path)) errs.push(`duplicate mount folder "${m.path || "/"}"`);
    paths.add(m.path);
    if (m.vaultId === "") errs.push(`mount "${m.path || "/"}" has no vault`);
    else if (ids.has(m.vaultId)) errs.push(`vault ${m.vaultId} mounted twice`);
    ids.add(m.vaultId);
  }
  return errs;
};
