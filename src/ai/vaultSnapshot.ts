import type { App } from "obsidian";
import type { VaultSnapshot } from "./rules";

/** Adapts Obsidian's vault + metadataCache to the pure VaultSnapshot. */
export const takeSnapshot = (app: App): VaultSnapshot => {
  const files = app.vault.getFiles().map((f) => f.path);
  const byPath = new Map(app.vault.getFiles().map((f) => [f.path, f]));
  return {
    files,
    frontmatter: (p) => {
      const f = byPath.get(p);
      if (!f) return undefined;
      return app.metadataCache.getFileCache(f)?.frontmatter;
    },
    inlineTags: (p) => {
      const f = byPath.get(p);
      if (!f) return undefined;
      return app.metadataCache.getFileCache(f)?.tags?.map((t) => t.tag);
    },
    resolvedLinks: app.metadataCache.resolvedLinks,
    ctime: (p) => byPath.get(p)?.stat.ctime,
    now: Date.now(),
  };
};
