/*
 * Forked from Remotely Save (https://github.com/remotely-save/remotely-save),
 * file src/sync.ts at commit adacda7ee5cf95cfaeb646bb4a0862925e9a4d02 (9f67d41^),
 * the last Apache-2.0 version of the sync engine.
 * Copyright (c) fyears and Remotely Save contributors. Licensed under the Apache License, Version 2.0.
 *
 * Modified by obsi-mcp:
 *  - removed all imports of ../pro (account check, smart_conflict / isMergable /
 *    mergeFile / duplicateFile, file content history); only keep_newer and
 *    keep_larger conflict strategies remain;
 *  - aggregate-error npm package replaced by the native AggregateError (no Node built-ins on mobile);
 *  - removed profiler, sync-plan history and remote-metadata special names;
 *  - prev-sync records go through the small PrevSyncStore interface instead of localdb;
 *  - RemotelySavePluginSettings replaced by SyncSettings; added allowedHiddenDirs
 *    (so ".obsi/" is synced although it is a dot-folder);
 *  - syncer() returns a SyncResult instead of calling notification callbacks;
 *  - safety percentage check only applies from PROTECT_MODIFY_MIN_FILES files.
 */
import PQueue from "p-queue";
import XRegExp from "xregexp";
import type {
  ConflictActionType,
  EmptyFolderCleanType,
  Entity,
  MixedEntity,
  SyncDirectionType,
  SyncTriggerSourceType,
} from "./baseTypes";
import { copyFile, copyFileOrFolder, copyFolder } from "./copyLogic";
import type { FakeFs } from "./fsAll";
import type { FakeFsEncrypt } from "./fsEncrypt";
import type { PrevSyncStore } from "./syncDb";
import {
  atWhichLevel,
  getParentFolder,
  isHiddenPath,
  isSpecialFolderNameToSkip,
  unixTimeToStr,
} from "./misc";

/**
 * Settings of one sync run (replaces RemotelySavePluginSettings).
 */
export interface SyncSettings {
  concurrency?: number;
  syncConfigDir?: boolean;
  /** hidden top-level folders that must be synced although they start with "." (e.g. [".obsi"]) */
  allowedHiddenDirs?: string[];
  syncUnderscoreItems?: boolean;
  /** XRegExp patterns; matching keys are neither listed nor touched on any side */
  ignorePaths?: string[];
  howToCleanEmptyFolder?: EmptyFolderCleanType;
  skipSizeLargerThan?: number;
  conflictAction?: ConflictActionType;
  syncDirection?: SyncDirectionType;
  protectModifyPercentage?: number;
}

const copyEntityAndFixTimeFormat = (src: Entity) => {
  const result = Object.assign({}, src);
  if (result.mtimeCli !== undefined) {
    if (result.mtimeCli === 0) {
      result.mtimeCli = undefined;
    } else {
      result.mtimeCliFmt = unixTimeToStr(result.mtimeCli);
    }
  }
  if (result.mtimeSvr !== undefined) {
    if (result.mtimeSvr === 0) {
      result.mtimeSvr = undefined;
    } else {
      result.mtimeSvrFmt = unixTimeToStr(result.mtimeSvr);
    }
  }
  if (result.prevSyncTime !== undefined) {
    if (result.prevSyncTime === 0) {
      result.prevSyncTime = undefined;
    } else {
      result.prevSyncTimeFmt = unixTimeToStr(result.prevSyncTime);
    }
  }

  return result;
};

/**
 * Directly throw error here.
 * We can only defer the checking now, because before decryption we don't know whether it's a file or folder.
 * @param remote
 */
const ensureMTimeOfRemoteEntityValid = (remote: Entity) => {
  if (
    !remote.key!.endsWith("/") &&
    remote.mtimeCli === undefined &&
    remote.mtimeSvr === undefined
  ) {
    if (remote.key === remote.keyEnc) {
      throw Error(
        `Your remote file ${remote.key} has last modified time 0, don't know how to deal with it.`
      );
    } else {
      throw Error(
        `Your remote file ${remote.key} (encrypted as ${remote.keyEnc}) has last modified time 0, don't know how to deal with it.`
      );
    }
  }
  return remote;
};

const isInsideObsFolder = (x: string, configDir: string) => {
  if (!configDir.startsWith(".")) {
    throw Error(`configDir should starts with . but we get ${configDir}`);
  }
  return x === configDir || x.startsWith(`${configDir}/`);
};

const isSkipItemByName = (
  key: string,
  syncConfigDir: boolean,
  syncUnderscoreItems: boolean,
  configDir: string,
  ignorePaths: string[],
  allowedHiddenDirs: string[]
) => {
  if (key === undefined) {
    throw Error(`isSkipItemByName meets undefinded key!`);
  }
  if (ignorePaths !== undefined && ignorePaths.length > 0) {
    for (const r of ignorePaths) {
      if (XRegExp(r, "A").test(key)) {
        return true;
      }
    }
  }
  if (syncConfigDir && isInsideObsFolder(key, configDir)) {
    return false;
  }
  for (const d of allowedHiddenDirs) {
    // e.g. ".obsi": the folder itself and everything inside is synced
    if (key === `${d}/` || key.startsWith(`${d}/`)) {
      return false;
    }
  }
  if (isSpecialFolderNameToSkip(key, [])) {
    // some special dirs and files are always skipped
    return true;
  }
  return (
    isHiddenPath(key, true, false) ||
    (!syncUnderscoreItems && isHiddenPath(key, false, true)) ||
    key === "/"
  );
};

export type SyncPlanType = Record<string, MixedEntity>;

const ensembleMixedEnties = async (
  localEntityList: Entity[],
  prevSyncEntityList: Entity[],
  remoteEntityList: Entity[],

  syncConfigDir: boolean,
  configDir: string,
  syncUnderscoreItems: boolean,
  ignorePaths: string[],
  allowedHiddenDirs: string[],
  fsEncrypt: FakeFsEncrypt
): Promise<SyncPlanType> => {

  const finalMappings: SyncPlanType = {};

  // remote has to be first
  for (const remote of remoteEntityList) {
    const remoteCopied = ensureMTimeOfRemoteEntityValid(
      copyEntityAndFixTimeFormat(remote)
    );

    const key = remoteCopied.key!;
    if (
      isSkipItemByName(
        key,
        syncConfigDir,
        syncUnderscoreItems,
        configDir,
        ignorePaths,
        allowedHiddenDirs
      )
    ) {
      continue;
    }

    finalMappings[key] = {
      key: key,
      remote: remoteCopied,
    };
  }


  if (Object.keys(finalMappings).length === 0 || localEntityList.length === 0) {
    // Special checking:
    // if one side is totally empty,
    // usually that's a hard rest.
    // So we need to ignore everything of prevSyncEntityList to avoid deletions!
    // TODO: acutally erase everything of prevSyncEntityList?
    // TODO: local should also go through a isSkipItemByName checking beforehand
  } else {
    // normally go through the prevSyncEntityList
    for (const prevSync of prevSyncEntityList) {
      const key = prevSync.key!;
      if (
        isSkipItemByName(
          key,
          syncConfigDir,
          syncUnderscoreItems,
          configDir,
          ignorePaths,
          allowedHiddenDirs
        )
      ) {
        continue;
      }

      // TODO: abstraction leaking?
      const prevSyncCopied = await fsEncrypt.encryptEntity(
        copyEntityAndFixTimeFormat(prevSync)
      );
      if (finalMappings.hasOwnProperty(key)) {
        finalMappings[key].prevSync = prevSyncCopied;
      } else {
        finalMappings[key] = {
          key: key,
          prevSync: prevSyncCopied,
        };
      }
    }
  }


  // local has to be last
  // because we want to get keyEnc based on the remote
  // (we don't consume prevSync here because it gains no benefit)
  for (const local of localEntityList) {
    const key = local.key!;
    if (
      isSkipItemByName(
        key,
        syncConfigDir,
        syncUnderscoreItems,
        configDir,
        ignorePaths,
        allowedHiddenDirs
      )
    ) {
      continue;
    }

    // TODO: abstraction leaking?
    const localCopied = await fsEncrypt.encryptEntity(
      copyEntityAndFixTimeFormat(local)
    );
    if (finalMappings.hasOwnProperty(key)) {
      finalMappings[key].local = localCopied;
    } else {
      finalMappings[key] = {
        key: key,
        local: localCopied,
      };
    }
  }


  // console.debug("in the end of ensembleMixedEnties, finalMappings is:");
  // console.debug(finalMappings);

  return finalMappings;
};

/**
 * Heavy lifting.
 * Basically follow the sync algorithm of https://github.com/Jwink3101/syncrclone
 * Also deal with syncDirection which makes it more complicated
 */
const getSyncPlanInplace = async (
  mixedEntityMappings: Record<string, MixedEntity>,
  howToCleanEmptyFolder: EmptyFolderCleanType,
  skipSizeLargerThan: number,
  conflictAction: ConflictActionType,
  syncDirection: SyncDirectionType,
  settings: SyncSettings,
  triggerSource: SyncTriggerSourceType
) => {
  // from long(deep) to short(shadow)
  const sortedKeys = Object.keys(mixedEntityMappings).sort(
    (k1, k2) => k2.length - k1.length
  );

  const keptFolder = new Set<string>();
  const mayDeleteFolder = new Set<string>();

  for (let i = 0; i < sortedKeys.length; ++i) {
    if (i % 100 === 0) {
    }
    const key = sortedKeys[i];
    const mixedEntry = mixedEntityMappings[key];
    const { local, prevSync, remote } = mixedEntry;

    // console.debug(`getSyncPlanInplace: key=${key}`)

    if (key.endsWith("/")) {
      // folder
      // folder doesn't worry about mtime and size, only check their existences
      if (keptFolder.has(key)) {
        // parent should also be kept
        // console.debug(`${key} in keptFolder`)
        keptFolder.add(getParentFolder(key));
        mayDeleteFolder.delete(getParentFolder(key));
        // should fill the missing part
        if (local !== undefined && remote !== undefined) {
          mixedEntry.decisionBranch = 101;
          mixedEntry.decision = "folder_existed_both_then_do_nothing";
          mixedEntry.change = false;
        } else if (local !== undefined && remote === undefined) {
          if (syncDirection === "incremental_pull_only") {
            mixedEntry.decisionBranch = 107;
            mixedEntry.decision = "folder_to_skip";
            mixedEntry.change = false;
          } else {
            mixedEntry.decisionBranch = 102;
            mixedEntry.decision =
              "folder_existed_local_then_also_create_remote";
            mixedEntry.change = true;
          }
        } else if (local === undefined && remote !== undefined) {
          if (syncDirection === "incremental_push_only") {
            mixedEntry.decisionBranch = 108;
            mixedEntry.decision = "folder_to_skip";
            mixedEntry.change = false;
          } else {
            mixedEntry.decisionBranch = 103;
            mixedEntry.decision =
              "folder_existed_remote_then_also_create_local";
            mixedEntry.change = true;
          }
        } else {
          // why?? how??
          mixedEntry.decisionBranch = 104;
          mixedEntry.decision = "folder_to_be_created";
          mixedEntry.change = true;
        }
        keptFolder.delete(key); // no need to save it in the Set later
        mayDeleteFolder.delete(key); // must ignore this
      } else {
        if (howToCleanEmptyFolder === "skip") {
          mixedEntry.decisionBranch = 105;
          mixedEntry.decision = "folder_to_skip";
          mixedEntry.change = false;
          keptFolder.add(getParentFolder(key)); // we want to keep parent!
          mayDeleteFolder.delete(getParentFolder(key)); // we don't want to delete parent!
        } else if (howToCleanEmptyFolder === "clean_both") {
          if (local !== undefined && remote !== undefined) {
            if (syncDirection === "bidirectional") {
              if (mayDeleteFolder.has(key)) {
                // from 0.5.6 and on,
                // we only delete the folders caused by file deletion
                mixedEntry.decisionBranch = 106;
                mixedEntry.decision = "folder_to_be_deleted_on_both";
                mixedEntry.change = true;
                mayDeleteFolder.add(getParentFolder(key));
                mayDeleteFolder.delete(key); // good to remove now
              } else {
                mixedEntry.decisionBranch = 115;
                mixedEntry.decision = "folder_existed_both_then_do_nothing";
                mixedEntry.change = false;
                keptFolder.add(getParentFolder(key)); // we want to keep parent!
                mayDeleteFolder.delete(getParentFolder(key)); // we don't want to delete parent!
              }
            } else {
              // right now it does nothing because of "incremental"
              // TODO: should we delete??
              mixedEntry.decisionBranch = 109;
              mixedEntry.decision = "folder_to_skip";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key)); // we want to keep parent!
              mayDeleteFolder.delete(getParentFolder(key)); // we don't want to delete parent!
            }
          } else if (local !== undefined && remote === undefined) {
            if (syncDirection === "bidirectional") {
              if (mayDeleteFolder.has(key)) {
                // from 0.5.6 and on,
                // we only delete the folders caused by file deletion
                mixedEntry.decisionBranch = 110;
                mixedEntry.decision = "folder_to_be_deleted_on_local";
                mixedEntry.change = true;
                mayDeleteFolder.add(getParentFolder(key));
                mayDeleteFolder.delete(key); // good to remove now
              } else {
                // the folder might be created locally
                // so we want to create it remotely as well.
                mixedEntry.decisionBranch = 116;
                mixedEntry.decision =
                  "folder_existed_local_then_also_create_remote";
                mixedEntry.change = false;
                keptFolder.add(getParentFolder(key)); // we want to keep parent!
                mayDeleteFolder.delete(getParentFolder(key)); // we don't want to delete parent!
              }
            } else {
              // right now it does nothing because of "incremental"
              // TODO: should we delete??
              mixedEntry.decisionBranch = 111;
              mixedEntry.decision = "folder_to_skip";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key)); // we want to keep parent!
              mayDeleteFolder.delete(getParentFolder(key)); // we don't want to delete parent!
            }
          } else if (local === undefined && remote !== undefined) {
            if (syncDirection === "bidirectional") {
              if (mayDeleteFolder.has(key)) {
                // from 0.5.6 and on,
                // we only delete the folders caused by file deletion
                mixedEntry.decisionBranch = 112;
                mixedEntry.decision = "folder_to_be_deleted_on_remote";
                mixedEntry.change = true;
                mayDeleteFolder.add(getParentFolder(key));
                mayDeleteFolder.delete(key); // good to remove now
              } else {
                // the folder might be created remotely
                // so we want to create it locally as well.
                mixedEntry.decisionBranch = 117;
                mixedEntry.decision =
                  "folder_existed_remote_then_also_create_local";
                mixedEntry.change = false;
                keptFolder.add(getParentFolder(key)); // we want to keep parent!
                mayDeleteFolder.delete(getParentFolder(key)); // we don't want to delete parent!
              }
            } else {
              // right now it does nothing because of "incremental"
              // TODO: should we delete??
              mixedEntry.decisionBranch = 113;
              mixedEntry.decision = "folder_to_skip";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key)); // we want to keep parent!
              mayDeleteFolder.delete(getParentFolder(key)); // we don't want to delete parent!
            }
          } else {
            // local === undefined && remote === undefined
            // no folder to delete, do nothing
            mixedEntry.decisionBranch = 114;
            mixedEntry.decision = "folder_to_skip";
            mixedEntry.change = false;
          }
        } else {
          throw Error(
            `do not know how to deal with empty folder ${mixedEntry.key}`
          );
        }
      }
    } else {
      // file

      if (local === undefined && remote === undefined) {
        // both deleted, only in history
        mixedEntry.decisionBranch = 1;
        mixedEntry.decision = "only_history";
        mixedEntry.change = false;
      } else if (local !== undefined && remote !== undefined) {
        if (
          (local.mtimeCli === remote.mtimeCli ||
            local.mtimeCli === remote.mtimeSvr) &&
          local.sizeEnc === remote.sizeEnc
        ) {
          // completely equal / identical
          mixedEntry.decisionBranch = 2;
          mixedEntry.decision = "equal";
          mixedEntry.change = false;
          keptFolder.add(getParentFolder(key));
        } else {
          // Both exists, but modified or conflict
          // Look for past files of A or B.
          const localEqualPrevSync =
            prevSync?.mtimeCli === local.mtimeCli &&
            prevSync?.sizeEnc === local.sizeEnc;
          const remoteEqualPrevSync =
            (prevSync?.mtimeSvr === remote.mtimeCli ||
              prevSync?.mtimeSvr === remote.mtimeSvr) &&
            prevSync?.sizeEnc === remote.sizeEnc;

          if (localEqualPrevSync && !remoteEqualPrevSync) {
            // If only one compares true (no prev also means it compares False), the other is modified. Backup and sync.
            if (
              skipSizeLargerThan <= 0 ||
              remote.sizeEnc! <= skipSizeLargerThan
            ) {
              if (syncDirection === "incremental_push_only") {
                mixedEntry.decisionBranch = 26;
                mixedEntry.decision = "conflict_modified_then_keep_local";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else {
                mixedEntry.decisionBranch = 9;
                mixedEntry.decision = "remote_is_modified_then_pull";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              }
            } else {
              throw Error(
                `remote is modified (branch 9) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                  mixedEntry
                )}`
              );
            }
          } else if (!localEqualPrevSync && remoteEqualPrevSync) {
            // If only one compares true (no prev also means it compares False), the other is modified. Backup and sync.
            if (
              skipSizeLargerThan <= 0 ||
              local.sizeEnc! <= skipSizeLargerThan
            ) {
              if (syncDirection === "incremental_pull_only") {
                mixedEntry.decisionBranch = 27;
                mixedEntry.decision = "conflict_modified_then_keep_remote";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else {
                mixedEntry.decisionBranch = 10;
                mixedEntry.decision = "local_is_modified_then_push";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              }
            } else {
              throw Error(
                `local is modified (branch 10) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                  mixedEntry
                )}`
              );
            }
          } else if (!localEqualPrevSync && !remoteEqualPrevSync) {
            // If both compare False (Didn't exist means both are new. Both exist but don't compare means both are modified)
            if (prevSync === undefined) {
              // Didn't exist means both are new
              if (syncDirection === "bidirectional") {
                if (conflictAction === "keep_newer") {
                  if (
                    (local.mtimeCli ?? local.mtimeSvr ?? 0) >=
                    (remote.mtimeCli ?? remote.mtimeSvr ?? 0)
                  ) {
                    mixedEntry.decisionBranch = 11;
                    mixedEntry.decision = "conflict_created_then_keep_local";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  } else {
                    mixedEntry.decisionBranch = 12;
                    mixedEntry.decision = "conflict_created_then_keep_remote";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  }
                } else if (conflictAction === "keep_larger") {
                  if (local.sizeEnc! >= remote.sizeEnc!) {
                    mixedEntry.decisionBranch = 13;
                    mixedEntry.decision = "conflict_created_then_keep_local";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  } else {
                    mixedEntry.decisionBranch = 14;
                    mixedEntry.decision = "conflict_created_then_keep_remote";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  }
                }
              } else if (syncDirection === "incremental_pull_only") {
                mixedEntry.decisionBranch = 22;
                mixedEntry.decision = "conflict_created_then_keep_remote";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else if (syncDirection === "incremental_push_only") {
                mixedEntry.decisionBranch = 23;
                mixedEntry.decision = "conflict_created_then_keep_local";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else {
                throw Error(
                  `no idea how to deal with syncDirection=${syncDirection} while conflict created`
                );
              }
            } else {
              // Both exist but don't compare means both are modified
              if (syncDirection === "bidirectional") {
                if (conflictAction === "keep_newer") {
                  if (
                    (local.mtimeCli ?? local.mtimeSvr ?? 0) >=
                    (remote.mtimeCli ?? remote.mtimeSvr ?? 0)
                  ) {
                    mixedEntry.decisionBranch = 16;
                    mixedEntry.decision = "conflict_modified_then_keep_local";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  } else {
                    mixedEntry.decisionBranch = 17;
                    mixedEntry.decision = "conflict_modified_then_keep_remote";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  }
                } else if (conflictAction === "keep_larger") {
                  if (local.sizeEnc! >= remote.sizeEnc!) {
                    mixedEntry.decisionBranch = 18;
                    mixedEntry.decision = "conflict_modified_then_keep_local";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  } else {
                    mixedEntry.decisionBranch = 19;
                    mixedEntry.decision = "conflict_modified_then_keep_remote";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  }
                }
              } else if (syncDirection === "incremental_pull_only") {
                mixedEntry.decisionBranch = 24;
                mixedEntry.decision = "conflict_modified_then_keep_remote";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else if (syncDirection === "incremental_push_only") {
                mixedEntry.decisionBranch = 25;
                mixedEntry.decision = "conflict_modified_then_keep_local";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else {
                throw Error(
                  `no idea how to deal with syncDirection=${syncDirection} while conflict modified`
                );
              }
            }
          } else {
            // Both compare true.
            // This is likely because of the mtimeCli and mtimeSvr tricks.
            // The result should be equal!!!
            mixedEntry.decisionBranch = 21;
            mixedEntry.decision = "equal";
            mixedEntry.change = false;
            keptFolder.add(getParentFolder(key));
          }
        }
      } else if (local === undefined && remote !== undefined) {
        // A is missing
        if (prevSync === undefined) {
          // if B is not in the previous list, B is new
          if (
            skipSizeLargerThan <= 0 ||
            remote.sizeEnc! <= skipSizeLargerThan
          ) {
            if (syncDirection === "incremental_push_only") {
              mixedEntry.decisionBranch = 28;
              mixedEntry.decision = "conflict_created_then_do_nothing";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 3;
              mixedEntry.decision = "remote_is_created_then_pull";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          } else {
            mixedEntry.decisionBranch = 36;
            mixedEntry.decision = "remote_is_created_too_large_then_do_nothing";
            mixedEntry.change = false;
            keptFolder.add(getParentFolder(key));
          }
        } else if (
          (prevSync.mtimeSvr === remote.mtimeCli ||
            prevSync.mtimeSvr === remote.mtimeSvr) &&
          prevSync.sizeEnc === remote.sizeEnc
        ) {
          // if B is in the previous list and UNMODIFIED, B has been deleted by A
          if (syncDirection === "incremental_push_only") {
            mixedEntry.decisionBranch = 29;
            mixedEntry.decision = "conflict_created_then_do_nothing";
            mixedEntry.change = false;
            keptFolder.add(getParentFolder(key));
          } else if (syncDirection === "incremental_pull_only") {
            mixedEntry.decisionBranch = 35;
            mixedEntry.decision = "conflict_created_then_keep_remote";
            mixedEntry.change = true;
            keptFolder.add(getParentFolder(key));
          } else {
            mixedEntry.decisionBranch = 4;
            mixedEntry.decision = "local_is_deleted_thus_also_delete_remote";
            mixedEntry.change = true;
            mayDeleteFolder.add(getParentFolder(key));
          }
        } else {
          // if B is in the previous list and MODIFIED, B has been deleted by A but modified by B
          if (
            skipSizeLargerThan <= 0 ||
            remote.sizeEnc! <= skipSizeLargerThan
          ) {
            if (syncDirection === "incremental_push_only") {
              mixedEntry.decisionBranch = 30;
              mixedEntry.decision = "conflict_created_then_do_nothing";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 5;
              mixedEntry.decision = "remote_is_modified_then_pull";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          } else {
            throw Error(
              `remote is modified (branch 5) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                mixedEntry
              )}`
            );
          }
        }
      } else if (local !== undefined && remote === undefined) {
        // B is missing

        if (prevSync === undefined) {
          // if A is not in the previous list, A is new
          if (skipSizeLargerThan <= 0 || local.sizeEnc! <= skipSizeLargerThan) {
            if (syncDirection === "incremental_pull_only") {
              mixedEntry.decisionBranch = 31;
              mixedEntry.decision = "conflict_created_then_do_nothing";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 6;
              mixedEntry.decision = "local_is_created_then_push";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          } else {
            mixedEntry.decisionBranch = 37;
            mixedEntry.decision = "local_is_created_too_large_then_do_nothing";
            mixedEntry.change = false;
            keptFolder.add(getParentFolder(key));
          }
        } else if (
          (prevSync.mtimeSvr === local.mtimeCli ||
            prevSync.mtimeCli === local.mtimeCli) &&
          prevSync.sizeEnc === local.sizeEnc
        ) {
          // if A is in the previous list and UNMODIFIED, A has been deleted by B
          if (syncDirection === "incremental_push_only") {
            mixedEntry.decisionBranch = 32;
            mixedEntry.decision = "conflict_created_then_keep_local";
            mixedEntry.change = true;
          } else if (syncDirection === "incremental_pull_only") {
            mixedEntry.decisionBranch = 33;
            mixedEntry.decision = "conflict_created_then_do_nothing";
            mixedEntry.change = false;
          } else {
            mixedEntry.decisionBranch = 7;
            mixedEntry.decision = "remote_is_deleted_thus_also_delete_local";
            mixedEntry.change = true;
            mayDeleteFolder.add(getParentFolder(key));
          }
        } else {
          // if A is in the previous list and MODIFIED, A has been deleted by B but modified by A
          if (skipSizeLargerThan <= 0 || local.sizeEnc! <= skipSizeLargerThan) {
            if (syncDirection === "incremental_pull_only") {
              mixedEntry.decisionBranch = 34;
              mixedEntry.decision = "conflict_created_then_do_nothing";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 8;
              mixedEntry.decision = "local_is_modified_then_push";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          } else {
            throw Error(
              `local is modified (branch 8) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                mixedEntry
              )}`
            );
          }
        }
      } else {
        throw Error(
          `should not reach branch -1 while getting sync plan: ${JSON.stringify(
            mixedEntry
          )}`
        );
      }

      if (mixedEntry.decision === undefined) {
        throw Error(
          `unexpectedly no decision of file in the end: ${JSON.stringify(
            mixedEntry
          )}`
        );
      }
    }
  }


  keptFolder.delete("/");
  keptFolder.delete("");
  mayDeleteFolder.delete("/");
  mayDeleteFolder.delete("");

  if (keptFolder.size > 0) {
    throw Error(`unexpectedly keptFolder no decisions: ${[...keptFolder]}`);
  }

  // finally we want to make our life easier
  const currTime = Date.now();
  const currTimeFmt = unixTimeToStr(currTime);
  // because the path should not as / in the beginning,
  // we should be safe to add these keys:
  mixedEntityMappings["/$@meta"] = {
    key: "/$@meta", // don't mess up with the types
    sideNotes: {
      version: "20240525 fs version",
      generateTime: currTime,
      generateTimeFmt: currTimeFmt,
      concurrency: settings.concurrency,
      syncConfigDir: settings.syncConfigDir,
      syncUnderscoreItems: settings.syncUnderscoreItems,
      skipSizeLargerThan: settings.skipSizeLargerThan,
      protectModifyPercentage: settings.protectModifyPercentage,
      conflictAction: conflictAction,
      syncDirection: syncDirection,
      triggerSource: triggerSource,
    },
  };


  return mixedEntityMappings;
};

const splitFourStepsOnEntityMappings = (
  mixedEntityMappings: Record<string, MixedEntity>
) => {
  type StepArrayType = MixedEntity[] | undefined | null;
  const onlyMarkSyncedOps: StepArrayType[] = [];
  const folderCreationOps: StepArrayType[] = [];
  const deletionOps: StepArrayType[] = [];
  const uploadDownloads: StepArrayType[] = [];

  // from long(deep) to short(shadow)
  const sortedKeys = Object.keys(mixedEntityMappings).sort(
    (k1, k2) => k2.length - k1.length
  );

  let allFilesCount = 0; // how many files in entities
  let realModifyDeleteCount = 0; // how many files to be modified / deleted
  let realTotalCount = 0; // how many files to be delt with

  for (let i = 0; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i];

    if (key === "/$@meta") {
      continue; // special
    }

    const val = mixedEntityMappings[key];

    if (!key.endsWith("/")) {
      allFilesCount += 1;
    }

    if (
      val.decision === "local_is_created_too_large_then_do_nothing" ||
      val.decision === "remote_is_created_too_large_then_do_nothing" ||
      val.decision === "folder_to_skip"
    ) {
      // pass
    } else if (
      val.decision === "equal" ||
      val.decision === "conflict_created_then_do_nothing" ||
      val.decision === "folder_existed_both_then_do_nothing"
    ) {
      if (
        onlyMarkSyncedOps.length === 0 ||
        onlyMarkSyncedOps[0] === undefined ||
        onlyMarkSyncedOps[0] === null
      ) {
        onlyMarkSyncedOps[0] = [val];
      } else {
        onlyMarkSyncedOps[0].push(val); // only one level is needed here
      }

      // don't need to update realTotalCount here
    } else if (
      val.decision === "folder_existed_local_then_also_create_remote" ||
      val.decision === "folder_existed_remote_then_also_create_local" ||
      val.decision === "folder_to_be_created"
    ) {
      // console.debug(`splitting folder: key=${key},val=${JSON.stringify(val)}`);
      const level = atWhichLevel(key);
      // console.debug(`atWhichLevel: ${level}`);
      const k = folderCreationOps[level - 1];
      if (k === undefined || k === null) {
        folderCreationOps[level - 1] = [val];
      } else {
        k.push(val);
      }
      realTotalCount += 1;
    } else if (
      val.decision === "only_history" ||
      val.decision === "local_is_deleted_thus_also_delete_remote" ||
      val.decision === "remote_is_deleted_thus_also_delete_local" ||
      val.decision === "folder_to_be_deleted_on_both" ||
      val.decision === "folder_to_be_deleted_on_local" ||
      val.decision === "folder_to_be_deleted_on_remote"
    ) {
      const level = atWhichLevel(key);
      const k = deletionOps[level - 1];
      if (k === undefined || k === null) {
        deletionOps[level - 1] = [val];
      } else {
        k.push(val);
      }
      realTotalCount += 1;

      if (
        val.decision.includes("deleted") &&
        !val.decision.includes("folder")
      ) {
        // only count files here, skip folder
        realModifyDeleteCount += 1;
      }
    } else if (
      val.decision === "local_is_modified_then_push" ||
      val.decision === "remote_is_modified_then_pull" ||
      val.decision === "local_is_created_then_push" ||
      val.decision === "remote_is_created_then_pull" ||
      val.decision === "conflict_created_then_keep_local" ||
      val.decision === "conflict_created_then_keep_remote" ||
      val.decision === "conflict_modified_then_keep_local" ||
      val.decision === "conflict_modified_then_keep_remote"
    ) {
      if (
        uploadDownloads.length === 0 ||
        uploadDownloads[0] === undefined ||
        uploadDownloads[0] === null
      ) {
        uploadDownloads[0] = [val];
      } else {
        uploadDownloads[0].push(val); // only one level is needed here
      }
      realTotalCount += 1;

      if (
        val.decision.includes("modified") ||
        val.decision.includes("conflict")
      ) {
        realModifyDeleteCount += 1;
      }
    } else {
      throw Error(`unknown decision ${val.decision} for ${key}`);
    }
  }

  // the deletionOps should be run from max level to min level
  // right now it is sorted by level from min to max (NOT length of key!)
  // so we need to reverse it!
  deletionOps.reverse(); // inplace reverse

  return {
    onlyMarkSyncedOps: onlyMarkSyncedOps,
    folderCreationOps: folderCreationOps,
    deletionOps: deletionOps,
    uploadDownloads: uploadDownloads,
    allFilesCount: allFilesCount,
    realModifyDeleteCount: realModifyDeleteCount,
    realTotalCount: realTotalCount,
  };
};

const fullfillMTimeOfRemoteEntityInplace = (
  remote: Entity,
  mtimeCli?: number
) => {
  // TODO:
  // on 20240405, we find that dropbox's mtimeCli is not updated
  // if the content is not updated even the time is updated...
  // so we do not check remote.mtimeCli for now..
  if (
    mtimeCli !== undefined &&
    mtimeCli > 0 /* &&
    (remote.mtimeCli === undefined ||
      remote.mtimeCli <= 0 ||
      (remote.mtimeSvr !== undefined &&
        remote.mtimeSvr > 0 &&
        remote.mtimeCli >= remote.mtimeSvr))
    */
  ) {
    remote.mtimeCli = mtimeCli;
  }
  return remote;
};

/**
 * Safety check (protectModifyPercentage) only makes sense with enough files;
 * with a handful of files a single edit would be "50%".
 * (obsi-mcp addition)
 */
const PROTECT_MODIFY_MIN_FILES = 10;

const dispatchOperationToActualV3 = async (
  key: string,
  stateId: string,
  r: MixedEntity,
  fsLocal: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  db: PrevSyncStore
) => {
  if (r.decision === "only_history") {
    await db.clear(stateId, key);
  } else if (
    r.decision === "local_is_created_too_large_then_do_nothing" ||
    r.decision === "remote_is_created_too_large_then_do_nothing" ||
    r.decision === "folder_to_skip"
  ) {
    // !! no actual sync being kept happens,
    // so no sync record here
    // pass
  } else if (
    r.decision === "equal" ||
    r.decision === "conflict_created_then_do_nothing" ||
    r.decision === "folder_existed_both_then_do_nothing"
  ) {
    // !! we MIGHT need to upsert the record,
    // so that next time we can determine the change delta

    if (r.prevSync !== undefined) {
      // if we have prevSync,
      // we don't need to update prevSync, because the record is already there!
    } else {
      // if we don't have prevSync, we use remote entity AND local mtime
      // as if it is "uploaded"
      if (r.remote !== undefined) {
        let entity = r.remote;
        // TODO: abstract away the dirty hack
        entity = fullfillMTimeOfRemoteEntityInplace(entity, r.local?.mtimeCli);

        if (entity !== undefined) {
          await db.upsert(stateId, entity);
        }
      }
    }
  } else if (
    r.decision === "local_is_modified_then_push" ||
    r.decision === "local_is_created_then_push" ||
    r.decision === "folder_existed_local_then_also_create_remote" ||
    r.decision === "conflict_created_then_keep_local" ||
    r.decision === "conflict_modified_then_keep_local"
  ) {
    const mtimeCli = (await fsLocal.stat(r.key)).mtimeCli!;
    const { entity } = await copyFileOrFolder(r.key, fsLocal, fsEncrypt);
    // TODO: abstract away the dirty hack
    fullfillMTimeOfRemoteEntityInplace(entity, mtimeCli);
    await db.upsert(stateId, entity);
  } else if (
    r.decision === "remote_is_modified_then_pull" ||
    r.decision === "remote_is_created_then_pull" ||
    r.decision === "conflict_created_then_keep_remote" ||
    r.decision === "conflict_modified_then_keep_remote" ||
    r.decision === "folder_existed_remote_then_also_create_local"
  ) {
    if (r.key.endsWith("/")) {
      await fsLocal.mkdir(r.key);
    } else {
      await copyFile(r.key, fsEncrypt, fsLocal);
    }
    await db.upsert(stateId, r.remote!);
  } else if (r.decision === "local_is_deleted_thus_also_delete_remote") {
    // local is deleted, we need to delete remote now
    await fsEncrypt.rm(r.key);
    await db.clear(stateId, r.key);
  } else if (r.decision === "remote_is_deleted_thus_also_delete_local") {
    // remote is deleted, we need to delete local now
    await fsLocal.rm(r.key);
    await db.clear(stateId, r.key);
  } else if (r.decision === "folder_to_be_created") {
    await fsLocal.mkdir(r.key);
    const { entity } = await copyFolder(r.key, fsLocal, fsEncrypt);
    await db.upsert(stateId, entity);
  } else if (
    r.decision === "folder_to_be_deleted_on_both" ||
    r.decision === "folder_to_be_deleted_on_local" ||
    r.decision === "folder_to_be_deleted_on_remote"
  ) {
    if (
      r.decision === "folder_to_be_deleted_on_both" ||
      r.decision === "folder_to_be_deleted_on_local"
    ) {
      await fsLocal.rm(r.key);
    }
    if (
      r.decision === "folder_to_be_deleted_on_both" ||
      r.decision === "folder_to_be_deleted_on_remote"
    ) {
      await fsEncrypt.rm(r.key);
    }
    await db.clear(stateId, r.key);
  } else {
    throw Error(`don't know how to dispatch decision: ${JSON.stringify(r)}`);
  }
};

export const doActualSync = async (
  mixedEntityMappings: Record<string, MixedEntity>,
  fsLocal: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  stateId: string,
  concurrency: number,
  protectModifyPercentage: number,
  db: PrevSyncStore,
  callbackSyncProcess?: any
) => {
  const {
    onlyMarkSyncedOps,
    folderCreationOps,
    deletionOps,
    uploadDownloads,
    allFilesCount,
    realModifyDeleteCount,
    realTotalCount,
  } = splitFourStepsOnEntityMappings(mixedEntityMappings);
  // console.debug(`onlyMarkSyncedOps: ${JSON.stringify(onlyMarkSyncedOps)}`);
  // console.debug(`folderCreationOps: ${JSON.stringify(folderCreationOps)}`);
  // console.debug(`deletionOps: ${JSON.stringify(deletionOps)}`);
  // console.debug(`uploadDownloads: ${JSON.stringify(uploadDownloads)}`);



  if (
    protectModifyPercentage >= 0 &&
    realModifyDeleteCount >= 0 &&
    allFilesCount >= PROTECT_MODIFY_MIN_FILES
  ) {
    if (
      protectModifyPercentage === 100 &&
      realModifyDeleteCount === allFilesCount
    ) {
      // special treatment for 100%
      // let it pass, we do nothing here
    } else if (
      realModifyDeleteCount * 100 >=
      allFilesCount * protectModifyPercentage
    ) {
      const errorStr = `Sync aborted by the safety check: ${realModifyDeleteCount} of ${allFilesCount} files would be modified or deleted (limit ${protectModifyPercentage}%). Raise the limit in settings if this is intended.`;

      throw Error(errorStr);
    }
  }

  const nested = [
    onlyMarkSyncedOps,
    folderCreationOps,
    deletionOps,
    uploadDownloads,
  ];
  const logTexts = [
    `1. record the items already being synced`,
    `2. create all folders from shadowest to deepest`,
    `3. delete files and folders from deepest to shadowest`,
    `4. upload or download files in parallel, with the desired concurrency=${concurrency}`,
  ];

  let realCounter = 0;
  for (let i = 0; i < nested.length; ++i) {

    const operations = nested[i];
    // console.debug(`curr operations=${JSON.stringify(operations, null, 2)}`);

    for (let j = 0; j < operations.length; ++j) {
      const singleLevelOps = operations[j];
      // console.debug(
      //   `singleLevelOps=${JSON.stringify(singleLevelOps, null, 2)}`
      // );
      if (singleLevelOps === undefined || singleLevelOps === null) {
        continue;
      }

      const queue = new PQueue({ concurrency: concurrency, autoStart: true });
      const potentialErrors: Error[] = [];
      let tooManyErrors = false;

      for (let k = 0; k < singleLevelOps.length; ++k) {
        const val = singleLevelOps[k];
        const key = val.key;

        const fn = async () => {
          // console.debug(
          //   `start syncing "${key}" with plan ${JSON.stringify(val)}`
          // );

          await callbackSyncProcess?.(
            realCounter,
            realTotalCount,
            key,
            val.decision
          );

          realCounter += 1;

          await dispatchOperationToActualV3(
            key,
            stateId,
            val,
            fsLocal,
            fsEncrypt,
            db
          );

          // console.debug(`finished ${key}`);
        };

        queue.add(fn).catch((e) => {
          const msg = `${key}: ${e.message}`;
          potentialErrors.push(new Error(msg));
          if (potentialErrors.length >= 3) {
            tooManyErrors = true;
            queue.pause();
            queue.clear();
          }
        });
      }

      await queue.onIdle();

      if (potentialErrors.length > 0) {
        if (tooManyErrors) {
          potentialErrors.push(
            new Error("too many errors, stop the remaining tasks")
          );
        }
        throw new AggregateError(
          potentialErrors,
          potentialErrors.map((e) => e.message).join("; ")
        );
      }
    }

  }

};


export type SyncStatusType =
  | "idle"
  | "preparing"
  | "getting_remote_files_list"
  | "getting_local_meta"
  | "getting_local_prev_sync"
  | "checking_password"
  | "generating_plan"
  | "syncing"
  | "cleaning"
  | "finish";

export interface SyncResult {
  ok: boolean;
  error?: Error;
  /** the plan that was computed (also for dry runs) */
  plan?: SyncPlanType;
}

/**
 * Every input variable should be mockable, so that testable.
 * (obsi-mcp: returns a SyncResult instead of only notifying; errors never throw.)
 */
export async function syncer(
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  db: PrevSyncStore,
  triggerSource: SyncTriggerSourceType,
  stateId: string,
  configDir: string,
  settings: SyncSettings,
  progress?: (step: number, info?: { done?: number; total?: number; key?: string }) => void
): Promise<SyncResult> {
  let plan: SyncPlanType | undefined = undefined;
  try {
    progress?.(1);
    if (fsEncrypt.innerFs !== fsRemote) {
      throw Error(`your enc should has inner of the remote`);
    }
    const passwordCheckResult = await fsEncrypt.isPasswordOk();
    if (!passwordCheckResult.ok) {
      throw Error(`password check failed: ${passwordCheckResult.reason}`);
    }

    progress?.(2);
    const remoteEntityList = await fsEncrypt.walk();

    progress?.(3);
    const localEntityList = await fsLocal.walk();

    progress?.(4);
    const prevSyncEntityList = await db.getAll(stateId);

    progress?.(5);
    let mixedEntityMappings = await ensembleMixedEnties(
      localEntityList,
      prevSyncEntityList,
      remoteEntityList,
      settings.syncConfigDir ?? false,
      configDir,
      settings.syncUnderscoreItems ?? false,
      settings.ignorePaths ?? [],
      settings.allowedHiddenDirs ?? [],
      fsEncrypt
    );

    mixedEntityMappings = await getSyncPlanInplace(
      mixedEntityMappings,
      settings.howToCleanEmptyFolder ?? "clean_both",
      settings.skipSizeLargerThan ?? -1,
      settings.conflictAction ?? "keep_newer",
      settings.syncDirection ?? "bidirectional",
      settings,
      triggerSource
    );
    plan = mixedEntityMappings;

    // The operations above are almost read only and kind of safe.
    // The operations below begins to write or delete (!!!) something.
    if (triggerSource !== "dry") {
      progress?.(6);
      await doActualSync(
        mixedEntityMappings,
        fsLocal,
        fsEncrypt,
        stateId,
        settings.concurrency ?? 5,
        settings.protectModifyPercentage ?? 50,
        db,
        async (done: number, total: number, key: string) => {
          progress?.(6, { done, total, key });
        }
      );
    }
    progress?.(7);
    return { ok: true, plan };
  } catch (error: any) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
      plan,
    };
  }
}
