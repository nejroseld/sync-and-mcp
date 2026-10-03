/*
 * Forked from Remotely Save (https://github.com/remotely-save/remotely-save),
 * file src/misc.ts at commit adacda7ee5cf95cfaeb646bb4a0862925e9a4d02 (9f67d41^),
 * the last Apache-2.0 version of the sync engine.
 * Copyright (c) fyears and Remotely Save contributors. Licensed under the Apache License, Version 2.0.
 *
 * Modified by obsi-mcp: pruned to the helpers the sync engine needs; Buffer imported explicitly (mobile has no global Buffer); window.moment replaced by plain Date formatting; 'path' resolved to path-browserify by the bundler; extra hidden-dir allowance helpers added.
 */

import * as path from "path";
import type { DataAdapter } from "obsidian";
import { Buffer } from "buffer";
import XRegExp from "xregexp";

/**
 * If any part of the file starts with '.' or '_' then it's a hidden file.
 */
export const isHiddenPath = (item: string, dot = true, underscore = true) => {
  if (!(dot || underscore)) {
    throw Error("parameter error for isHiddenPath");
  }
  const k = path.posix.normalize(item); // TODO: only unix path now
  const k2 = k.split("/"); // TODO: only unix path now
  for (const singlePart of k2) {
    if (singlePart === "." || singlePart === ".." || singlePart === "") {
      continue;
    }
    if (dot && singlePart[0] === ".") {
      return true;
    }
    if (underscore && singlePart[0] === "_") {
      return true;
    }
  }
  return false;
};

/**
 * "a/b/c/" => ["a", "a/b", "a/b/c"]
 * "a/b/c/d/e.txt" => ["a", "a/b", "a/b/c", "a/b/c/d"]
 */
export const getFolderLevels = (x: string, addEndingSlash = false) => {
  const res: string[] = [];

  if (x === "" || x === "/") {
    return res;
  }

  const y1 = x.split("/");
  for (let index = 0; index + 1 < y1.length; index++) {
    let k = y1.slice(0, index + 1).join("/");
    if (k === "" || k === "/") {
      continue;
    }
    if (addEndingSlash) {
      k = `${k}/`;
    }
    res.push(k);
  }
  return res;
};

/** mkdir -p on a DataAdapter (modified: takes adapter instead of Vault). */
export const mkdirpInVault = async (thePath: string, adapter: DataAdapter) => {
  const foldersToBuild = getFolderLevels(thePath);
  for (const folder of foldersToBuild) {
    const r = await adapter.exists(folder);
    if (!r) {
      await adapter.mkdir(folder);
    }
  }
};

export const bufferToArrayBuffer = (
  b: Buffer | Uint8Array | ArrayBufferView
) => {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

export const hexStringToTypedArray = (hex: string) => {
  const f = hex.match(/[\da-f]{2}/gi);
  if (f === null) {
    throw Error(`input ${hex} is not hex, no way to transform`);
  }
  return new Uint8Array(f.map((h) => Number.parseInt(h, 16)));
};

/**
 * iOS Safari could decrypt string with invalid password!
 * So we need an extra way to test the decrypted result: printable chars only.
 */
export const isVaildText = (a: string) => {
  if (a === undefined) {
    return false;
  }
  // If the regex matches, the string is invalid.
  return !XRegExp("\\p{Cc}|\\p{Cf}|\\p{Co}|\\p{Cn}|\\p{Zl}|\\p{Zp}", "A").test(
    a
  );
};

/**
 * If input is already a folder, returns its folder;
 * And if input is a file, returns its direname.
 */
export const getParentFolder = (a: string) => {
  const b = path.posix.dirname(a);
  if (b === "." || b === "/") {
    // the root
    return "/";
  }
  if (b.endsWith("/")) {
    return b;
  }
  return `${b}/`;
};

export const atWhichLevel = (x: string | undefined) => {
  if (
    x === undefined ||
    x === "" ||
    x === "." ||
    x === ".." ||
    x.startsWith("/")
  ) {
    throw Error(`do not know which level for ${x}`);
  }
  let y = x;
  if (x.endsWith("/")) {
    y = x.slice(0, -1);
  }
  return y.split("/").length;
};

/** modified: no moment dependency. 1716712162574 => '2024-05-26T16:29:22.574Z' */
export const unixTimeToStr = (x: number | undefined | null, hasMs = false) => {
  if (x === undefined || x === null || Number.isNaN(x)) {
    return undefined;
  }
  const s = new Date(x).toISOString();
  return hasMs ? s : s.replace(/\.\d{3}Z$/, "Z");
};

/**
 * On Android the stat has bugs for folders. So we need a fixed version.
 * (modified: takes adapter instead of Vault)
 */
export const statFix = async (adapter: DataAdapter, path: string) => {
  const s = await adapter.stat(path);
  if (s === undefined || s === null) {
    throw Error(`${path} doesn't exist cannot run stat`);
  }
  if (s.ctime === undefined || s.ctime === null || Number.isNaN(s.ctime)) {
    s.ctime = undefined as any; // force assignment
  }
  if (s.mtime === undefined || s.mtime === null || Number.isNaN(s.mtime)) {
    s.mtime = undefined as any; // force assignment
  }
  if (
    (s.size === undefined || s.size === null || Number.isNaN(s.size)) &&
    s.type === "folder"
  ) {
    s.size = 0;
  }
  return s;
};

export const isSpecialFolderNameToSkip = (
  x: string,
  more: string[] | undefined
) => {
  const specialFolders = [
    ".git",
    ".github",
    ".gitlab",
    ".svn",
    "node_modules",
    ".DS_Store",
    "__MACOSX ",
    "Icon\r", // https://superuser.com/questions/298785/icon-file-on-os-x-desktop
    "desktop.ini",
    "Desktop.ini",
    "thumbs.db",
    "Thumbs.db",
  ].concat(more !== undefined ? more : []);
  for (const iterator of specialFolders) {
    if (
      x === iterator ||
      x === `${iterator}/` ||
      x.endsWith(`/${iterator}`) ||
      x.endsWith(`/${iterator}/`)
    ) {
      return true;
    }
  }
  return false;
};
