/*
 * Forked from Remotely Save (https://github.com/remotely-save/remotely-save),
 * file src/fsLocal.ts at commit adacda7ee5cf95cfaeb646bb4a0862925e9a4d02 (9f67d41^),
 * the last Apache-2.0 version of the sync engine.
 * Copyright (c) fyears and Remotely Save contributors. Licensed under the Apache License, Version 2.0.
 *
 * Modified by obsi-mcp: profiler removed; walk() also lists configured hidden folders (e.g. .obsi/) through the adapter; writeFile creates parent folders; takes extraHiddenDirs; Vault helpers use adapter.
 */

import { type Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";

import { TFile, TFolder, type Vault } from "obsidian";
import { mkdirpInVault, statFix, unixTimeToStr } from "./misc";
import { listFilesInObsFolder } from "./obsFolderLister";

export class FakeFsLocal extends FakeFs {
  vault: Vault;
  syncConfigDir: boolean;
  configDir: string;
  pluginID: string;
  /** hidden folders (invisible to Obsidian's file index) to list through the adapter, e.g. [".obsi"] */
  extraHiddenDirs: string[];
  deleteToWhere: "obsidian" | "system";
  kind: "local";
  constructor(
    vault: Vault,
    syncConfigDir: boolean,
    configDir: string,
    pluginID: string,
    deleteToWhere: "obsidian" | "system",
    extraHiddenDirs: string[] = []
  ) {
    super();

    this.vault = vault;
    this.syncConfigDir = syncConfigDir;
    this.configDir = configDir;
    this.pluginID = pluginID;
    this.deleteToWhere = deleteToWhere;
    this.extraHiddenDirs = extraHiddenDirs;
    this.kind = "local";
  }

  async walk(): Promise<Entity[]> {
    const local: Entity[] = [];

    const localTAbstractFiles = this.vault.getAllLoadedFiles();
    for (const entry of localTAbstractFiles) {
      let r: Entity | undefined = undefined;
      let key = entry.path;
      if (key.startsWith("/")) {
        key = key.slice(1);
      }

      if (entry.path === "/" || entry.path === "") {
        // ignore
        continue;
      } else if (entry instanceof TFile) {
        let mtimeLocal: number | undefined = entry.stat.mtime;
        if (mtimeLocal <= 0) {
          mtimeLocal = entry.stat.ctime;
        }
        if (mtimeLocal === 0) {
          mtimeLocal = undefined;
        }
        if (mtimeLocal === undefined) {
          throw Error(
            `Your file has last modified time 0: ${key}, don't know how to deal with it`
          );
        }
        r = {
          key: key, // local always unencrypted
          keyRaw: key,
          mtimeCli: mtimeLocal,
          mtimeSvr: mtimeLocal,
          size: entry.stat.size, // local always unencrypted
          sizeRaw: entry.stat.size,
        };
      } else if (entry instanceof TFolder) {
        key = `${key}/`;
        r = {
          key: key,
          keyRaw: key,
          size: 0,
          sizeRaw: 0,
        };
      } else {
        throw Error(`unexpected ${entry}`);
      }
      local.push(r);
    }

    const hidden: { dir: string; pluginId: string | undefined }[] = [];
    if (this.syncConfigDir) {
      hidden.push({ dir: this.configDir, pluginId: this.pluginID });
    }
    for (const d of this.extraHiddenDirs) {
      hidden.push({ dir: d, pluginId: undefined });
    }
    for (const h of hidden) {
      const files = await listFilesInObsFolder(
        h.dir,
        this.vault.adapter,
        h.pluginId
      );
      for (const f of files) {
        local.push(f);
      }
    }

    return local;
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const statRes = await statFix(this.vault.adapter, key);
    const isFolder = statRes.type === "folder";
    return {
      key: isFolder ? `${key}/` : key, // local always unencrypted
      keyRaw: isFolder ? `${key}/` : key,
      mtimeCli: statRes.mtime,
      mtimeSvr: statRes.mtime,
      mtimeCliFmt: unixTimeToStr(statRes.mtime),
      mtimeSvrFmt: unixTimeToStr(statRes.mtime),
      size: statRes.size, // local always unencrypted
      sizeRaw: statRes.size,
    };
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    await mkdirpInVault(key, this.vault.adapter);
    return await this.stat(key);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    await mkdirpInVault(key, this.vault.adapter);
    await this.vault.adapter.writeBinary(key, content, {
      mtime: mtime,
      ctime: ctime,
    });
    return await this.stat(key);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    return await this.vault.adapter.readBinary(key);
  }

  async rename(key1: string, key2: string): Promise<void> {
    return await this.vault.adapter.rename(key1, key2);
  }

  async rm(key: string): Promise<void> {
    if (this.deleteToWhere === "obsidian") {
      await this.vault.adapter.trashLocal(key);
    } else {
      // "system"
      if (!(await this.vault.adapter.trashSystem(key))) {
        await this.vault.adapter.trashLocal(key);
      }
    }
  }
  async checkConnect(_callbackFunc?: unknown): Promise<boolean> {
    return true;
  }

  async getUserDisplayName(): Promise<string> {
    throw new Error("Method not implemented.");
  }

  async revokeAuth(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
