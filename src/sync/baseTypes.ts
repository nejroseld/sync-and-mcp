/*
 * Forked from Remotely Save (https://github.com/remotely-save/remotely-save),
 * file src/baseTypes.ts at commit adacda7ee5cf95cfaeb646bb4a0862925e9a4d02 (9f67d41^),
 * the last Apache-2.0 version of the sync engine.
 * Copyright (c) fyears and Remotely Save contributors. Licensed under the Apache License, Version 2.0.
 *
 * Modified by obsi-mcp: all backends (S3/WebDAV/Dropbox/OneDrive/pro services), settings, i18n and smart_conflict removed; only types used by the sync engine remain.
 */

/**
 * Only type defs here.
 * To avoid circular dependency.
 */

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export type SyncDirectionType =
  | "bidirectional"
  | "incremental_pull_only"
  | "incremental_push_only";

/** Legacy/unsupported methods are retained only to prevent silently switching ciphers. */
export type CipherMethodType = "rclone-base64" | "unknown";

export type EmptyFolderCleanType = "skip" | "clean_both";

/** smart_conflict (Pro) and "keep both" are intentionally not supported. */
export type ConflictActionType = "keep_newer" | "keep_larger";

export type DecisionTypeForMixedEntity =
  | "only_history"
  | "equal"
  | "local_is_modified_then_push"
  | "remote_is_modified_then_pull"
  | "local_is_created_then_push"
  | "remote_is_created_then_pull"
  | "local_is_created_too_large_then_do_nothing"
  | "remote_is_created_too_large_then_do_nothing"
  | "local_is_deleted_thus_also_delete_remote"
  | "remote_is_deleted_thus_also_delete_local"
  | "conflict_created_then_keep_local"
  | "conflict_created_then_keep_remote"
  | "conflict_created_then_do_nothing"
  | "conflict_modified_then_keep_local"
  | "conflict_modified_then_keep_remote"
  | "folder_existed_both_then_do_nothing"
  | "folder_existed_local_then_also_create_remote"
  | "folder_existed_remote_then_also_create_local"
  | "folder_to_be_created"
  | "folder_to_skip"
  | "folder_to_be_deleted_on_both"
  | "folder_to_be_deleted_on_remote"
  | "folder_to_be_deleted_on_local";

/**
 * uniform representation
 * everything should be flat and primitive, so that we can copy.
 */
export interface Entity {
  key?: string;
  keyEnc?: string;
  keyRaw: string;
  mtimeCli?: number;
  mtimeCliFmt?: string;
  mtimeSvr?: number;
  mtimeSvrFmt?: string;
  prevSyncTime?: number;
  prevSyncTimeFmt?: string;
  size?: number; // might be unknown or to be filled
  sizeEnc?: number;
  sizeRaw: number;
  hash?: string;
  etag?: string;
  synthesizedFolder?: boolean;
  synthesizedFile?: boolean;
}

export interface UploadedType {
  entity: Entity;
  mtimeCli?: number;
}

/**
 * A replacement of FileOrFolderMixedState
 */
export interface MixedEntity {
  key: string;
  local?: Entity;
  prevSync?: Entity;
  remote?: Entity;

  decisionBranch?: number;
  decision?: DecisionTypeForMixedEntity;
  conflictAction?: ConflictActionType;

  change?: boolean;

  sideNotes?: SyncPlanSideNotes;
}

export type SyncTriggerSourceType =
  | "manual"
  | "dry"
  | "auto"
  | "auto_once_init"
  | "auto_sync_on_save";

/**
 * Metadata on the synthetic "/$@meta" plan entry.
 * Field values come from the sync run that built the plan.
 */
export interface SyncPlanSideNotes {
  version?: string;
  generateTime?: number;
  generateTimeFmt?: string;
  concurrency?: number;
  syncConfigDir?: boolean;
  syncUnderscoreItems?: boolean;
  skipSizeLargerThan?: number;
  protectModifyPercentage?: number;
  conflictAction?: ConflictActionType;
  syncDirection?: SyncDirectionType;
  triggerSource?: SyncTriggerSourceType;
}
