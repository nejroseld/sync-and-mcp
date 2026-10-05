/*
 * Forked from Remotely Save (https://github.com/remotely-save/remotely-save),
 * file src/fsAll.ts at commit adacda7ee5cf95cfaeb646bb4a0862925e9a4d02 (9f67d41^),
 * the last Apache-2.0 version of the sync engine.
 * Copyright (c) fyears and Remotely Save contributors. Licensed under the Apache License, Version 2.0.
 *
 * Modified by obsi-mcp: none (verbatim copy).
 */

import type { Entity } from "./baseTypes";

export abstract class FakeFs {
  abstract kind: string;
  abstract walk(): Promise<Entity[]>;
  abstract walkPartial(): Promise<Entity[]>;
  abstract stat(key: string): Promise<Entity>;
  abstract mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity>;
  abstract writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    isMarkdown?: boolean
  ): Promise<Entity>;
  abstract readFile(key: string): Promise<ArrayBuffer>;
  abstract rename(key1: string, key2: string, isMarkdown?: boolean): Promise<void>;
  abstract rm(key: string): Promise<void>;
  abstract checkConnect(callbackFunc?: any): Promise<boolean>;
  abstract getUserDisplayName(): Promise<string>;
  abstract revokeAuth(): Promise<any>;
  abstract allowEmptyFile(): boolean;
}
