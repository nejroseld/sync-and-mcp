/**
 * Pure logic of the AI Available publisher: desired set per vault + diff against the manifest.
 */
import { findOwningMount, toRelPath, type MountLike } from "../sync/mounts";
import type { ManifestFile } from "../api/types";
import { isNotePath } from "./rules";

export interface DesiredFile {
  /** path relative to the vault (mount) root */
  relPath: string;
  vaultPath: string;
  version: string; // sha256 hex
  mtime: number;
  size: number;
  kind: "note" | "attachment";
}

/**
 * Split allowed vault paths per mount (vault). A file belongs to the deepest mount that
 * contains it; files outside every mount are not published.
 */
export const groupAllowedByMount = <M extends MountLike>(
  allowedPaths: Iterable<string>,
  mounts: M[]
): Map<M, string[]> => {
  const res = new Map<M, string[]>();
  for (const p of allowedPaths) {
    const m = findOwningMount(p, mounts);
    if (m === undefined) continue;
    const arr = res.get(m) ?? [];
    arr.push(p);
    res.set(m, arr);
  }
  return res;
};

export const relPathFor = (vaultPath: string, mountPath: string) =>
  toRelPath(vaultPath, mountPath);

export const kindOf = (path: string): "note" | "attachment" =>
  isNotePath(path) ? "note" : "attachment";

export interface PublishDiff {
  put: DesiredFile[];
  del: string[];
}

export const computePublishDiff = (
  desired: DesiredFile[],
  manifest: Pick<ManifestFile, "path" | "version">[]
): PublishDiff => {
  const have = new Map(manifest.map((m) => [m.path, m.version]));
  const want = new Set<string>();
  const put: DesiredFile[] = [];
  for (const d of desired) {
    want.add(d.relPath);
    if (have.get(d.relPath) !== d.version) {
      put.push(d);
    }
  }
  const del = manifest.map((m) => m.path).filter((p) => !want.has(p));
  return { put, del };
};

export const sha256Hex = async (data: ArrayBuffer | Uint8Array): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
