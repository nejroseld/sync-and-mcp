/*
 * Forked from Remotely Save (https://github.com/remotely-save/remotely-save),
 * file src/obsFolderLister.ts at commit adacda7ee5cf95cfaeb646bb4a0862925e9a4d02 (9f67d41^),
 * the last Apache-2.0 version of the sync engine.
 * Copyright (c) fyears and Remotely Save contributors. Licensed under the Apache License, Version 2.0.
 *
 * Modified by obsi-mcp: generalised to list any hidden root folder (used for .obsi/ and optionally the Obsidian config dir); @fyears/tsqueue replaced by a plain array; missing roots are skipped; takes a DataAdapter.
 */

import type { DataAdapter, ListedFiles } from "obsidian";
import type { Entity } from "./baseTypes";

import chunk from "lodash/chunk";
import { isSpecialFolderNameToSkip, statFix } from "./misc";

const isPluginDirItself = (x: string, pluginId: string) => {
  return (
    x === pluginId ||
    x === `${pluginId}/` ||
    x.endsWith(`/${pluginId}`) ||
    x.endsWith(`/${pluginId}/`)
  );
};

const isLikelyPluginSubFiles = (x: string) => {
  const reqFiles = [
    "data.json",
    "main.js",
    "manifest.json",
    ".gitignore",
    "styles.css",
  ];
  for (const iterator of reqFiles) {
    if (x === iterator || x.endsWith(`/${iterator}`)) {
      return true;
    }
  }
  return false;
};

/**
 * List a hidden folder (not visible to vault.getAllLoadedFiles) via the adapter.
 * @param rootDir e.g. ".obsi" or the Obsidian config dir
 * @param pluginId if given, only the plugin's distribution files (main.js, manifest.json,
 *                 styles.css, data.json) are listed inside its own folder; data.json is then
 *                 excluded from sync by ownPluginDataIgnorePattern (runMount.ts)
 */
export const listFilesInObsFolder = async (
  rootDir: string,
  adapter: DataAdapter,
  pluginId: string | undefined
): Promise<Entity[]> => {
  const contents: Entity[] = [];
  if (!(await adapter.exists(rootDir))) {
    return contents;
  }
  let q: string[] = [rootDir];
  const CHUNK_SIZE = 10;
  while (q.length > 0) {
    const itemsToFetch = q;
    q = [];

    const itemsToFetchChunks = chunk(itemsToFetch, CHUNK_SIZE);
    for (const singleChunk of itemsToFetchChunks) {
      const r = singleChunk.map(async (x) => {
        const statRes = await statFix(adapter, x);
        const isFolder = statRes.type === "folder";
        let children: ListedFiles | undefined = undefined;
        if (isFolder) {
          children = await adapter.list(x);
        }

        if (
          !isFolder &&
          (statRes.mtime === undefined ||
            statRes.mtime === null ||
            statRes.mtime === 0)
        ) {
          throw Error(
            `File in ${rootDir} has last modified time 0: ${x}, don't know how to deal with it.`
          );
        }

        return {
          itself: {
            key: isFolder ? `${x}/` : x, // local always unencrypted
            keyRaw: isFolder ? `${x}/` : x,
            mtimeCli: statRes.mtime,
            mtimeSvr: statRes.mtime,
            size: statRes.size, // local always unencrypted
            sizeRaw: statRes.size,
          } as Entity,
          children: children,
        };
      });
      const r2 = await Promise.all(r);

      for (const iter of r2) {
        contents.push(iter.itself);
        const isInsideSelfPlugin =
          pluginId !== undefined && isPluginDirItself(iter.itself.key!, pluginId);
        if (iter.children !== undefined) {
          for (const iter2 of [
            ...iter.children.folders,
            ...iter.children.files,
          ]) {
            if (
              isSpecialFolderNameToSkip(iter2, ["workspace", "workspace.json"])
            ) {
              continue;
            }
            if (isInsideSelfPlugin && !isLikelyPluginSubFiles(iter2)) {
              continue;
            }
            q.push(iter2);
          }
        }
      }
    }
  }
  return contents;
};
