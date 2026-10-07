import type { ObsiApi } from "../api/client";
import type { CipherMethodType, SyncTriggerSourceType } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import { FakeFsEncrypt } from "./fsEncrypt";
import { FakeFsObsiServer } from "./fsObsiServer";
import { FakeFsSubtree } from "./fsSubtree";
import {
  ignorePatternsForNestedMounts,
  nestedMountPrefixes,
  normalizeMountPath,
} from "./mounts";
import { type SyncResult, type SyncSettings, syncer } from "./sync";
import type { PrevSyncStore } from "./syncDb";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The plugin's own data.json holds per-device secrets (device/admin tokens, vault passwords):
 * it must never be synced, in either direction, even when the config dir is synced.
 */
export const ownPluginDataIgnorePattern = (configDir: string, pluginId: string) =>
  `^${escapeRegex(configDir)}/plugins/${escapeRegex(pluginId)}/data\\.json$`;

export interface RunMountParams {
  api: ObsiApi;
  vaultId: string;
  mountPath: string;
  allMountPaths: string[];
  password: string;
  method: CipherMethodType;
  /** local FS of the whole Obsidian vault (FakeFsLocal in the plugin, memory fs in tests) */
  fsLocalWhole: FakeFs;
  db: PrevSyncStore;
  settings: SyncSettings;
  configDir: string;
  trigger: SyncTriggerSourceType;
  progress?: Parameters<typeof syncer>[8];
}

/**
 * Builds local(subtree) <-> encrypt(server(vault)) and runs the forked syncer once.
 * Each mount has its own prev-sync history (stateId = vaultId).
 */
export const runMountSync = async (p: RunMountParams): Promise<SyncResult> => {
  const mountPath = normalizeMountPath(p.mountPath);
  const nested = nestedMountPrefixes(mountPath, p.allMountPaths);
  const local = new FakeFsSubtree(p.fsLocalWhole, mountPath, nested);
  const remote = new FakeFsObsiServer(p.api, p.vaultId);
  const enc = new FakeFsEncrypt(remote, p.password, p.method);
  // The whole-vault mount always carries .obsi/ (AI rules and any other shared config).
  const allowedHidden = new Set(p.settings.allowedHiddenDirs ?? []);
  if (mountPath === "") allowedHidden.add(".obsi");
  const settings: SyncSettings = {
    ...p.settings,
    allowedHiddenDirs: [...allowedHidden],
    ignorePaths: [
      ...(p.settings.ignorePaths ?? []),
      ...ignorePatternsForNestedMounts(mountPath, p.allMountPaths),
    ],
  };
  try {
    return await syncer(
      local,
      remote,
      enc,
      p.db,
      p.trigger,
      p.vaultId,
      p.configDir,
      settings,
      p.progress
    );
  } finally {
    await enc.closeResources();
  }
};
