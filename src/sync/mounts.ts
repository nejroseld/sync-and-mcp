/**
 * Pure helpers for the mount tree: path <-> mount mapping and nested-mount exclusion.
 * No Obsidian dependency (unit-tested).
 */
export interface MountLike {
  /** folder path in the vault, "" = vault root */
  path: string;
  vaultId: string;
}

/** "/a/b/" -> "a/b", "/" -> "" */
export const normalizeMountPath = (p: string) =>
  p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

/** Last segment of a folder path, for naming a server vault created from that folder. "" for the vault root. */
export const folderVaultName = (path: string): string => {
  const parts = normalizeMountPath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
};

/** true if `inner` is inside (or equal to) folder `outer` (both normalized, "" = root) */
export const isPathInside = (inner: string, outer: string) =>
  outer === "" || inner === outer || inner.startsWith(`${outer}/`);

/** prefixes of all mounts strictly nested inside `mountPath`, shortest only (no redundancy) */
export const nestedMountPrefixes = (
  mountPath: string,
  allMountPaths: string[]
): string[] => {
  const me = normalizeMountPath(mountPath);
  const inner = allMountPaths
    .map(normalizeMountPath)
    .filter((p) => p !== me && p !== "" && isPathInside(p, me));
  const res: string[] = [];
  for (const p of [...new Set(inner)].sort((a, b) => a.length - b.length)) {
    if (!res.some((r) => isPathInside(p, r))) {
      res.push(p);
    }
  }
  return res;
};

/** deepest mount that contains the vault path (the one that "owns" the file); undefined if none */
export const findOwningMount = <T extends MountLike>(
  vaultPath: string,
  mounts: T[]
): T | undefined => {
  const p = normalizeMountPath(vaultPath);
  let best: T | undefined;
  for (const m of mounts) {
    const mp = normalizeMountPath(m.path);
    if (isPathInside(p, mp)) {
      if (best === undefined || mp.length > normalizeMountPath(best.path).length) {
        best = m;
      }
    }
  }
  return best;
};

/** vault path -> path relative to mount root (undefined if outside) */
export const toRelPath = (vaultPath: string, mountPath: string) => {
  const p = vaultPath.replace(/^\/+/, "");
  const mp = normalizeMountPath(mountPath);
  if (mp === "") {
    return p;
  }
  if (p.startsWith(`${mp}/`)) {
    return p.slice(mp.length + 1);
  }
  return undefined;
};

/** relative path inside mount -> vault path */
export const toVaultPath = (relPath: string, mountPath: string) => {
  const mp = normalizeMountPath(mountPath);
  return mp === "" ? relPath : `${mp}/${relPath}`;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** XRegExp patterns for the sync engine's ignorePaths: skip nested mounts (keys are relative to the mount) */
export const ignorePatternsForNestedMounts = (
  mountPath: string,
  allMountPaths: string[]
): string[] => {
  const me = normalizeMountPath(mountPath);
  return nestedMountPrefixes(me, allMountPaths).map((p) => {
    const rel = toRelPath(p, me)!;
    return `^${escapeRe(rel)}(/|$)`;
  });
};
