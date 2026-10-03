/*
 * Forked from Remotely Save (https://github.com/remotely-save/remotely-save),
 * file src/copyLogic.ts at commit adacda7ee5cf95cfaeb646bb4a0862925e9a4d02 (9f67d41^),
 * the last Apache-2.0 version of the sync engine.
 * Copyright (c) fyears and Remotely Save contributors. Licensed under the Apache License, Version 2.0.
 *
 * Modified by obsi-mcp: none (verbatim copy).
 */

import type { FakeFs } from "./fsAll";

export async function copyFolder(key: string, left: FakeFs, right: FakeFs) {
  if (!key.endsWith("/")) {
    throw Error(`should not call ${key} in copyFolder`);
  }
  const statsLeft = await left.stat(key);
  const entity = await right.mkdir(key, statsLeft.mtimeCli);
  return {
    entity: entity,
    content: undefined,
  };
}

export async function copyFile(key: string, left: FakeFs, right: FakeFs) {
  // console.debug(`copyFile: key=${key}, left=${left.kind}, right=${right.kind}`);
  if (key.endsWith("/")) {
    throw Error(`should not call ${key} in copyFile`);
  }
  const statsLeft = await left.stat(key);
  const content = await left.readFile(key);

  if (statsLeft.size === undefined || statsLeft.size === 0) {
    // some weird bugs on android not returning size. just ignore them
    statsLeft.size = content.byteLength;
  } else {
    if (statsLeft.size !== content.byteLength) {
      throw Error(
        `error copying ${left.kind}=>${right.kind}: size not matched`
      );
    }
  }

  if (statsLeft.mtimeCli === undefined) {
    throw Error(`error copying ${left.kind}=>${right.kind}, no mtimeCli`);
  }

  // console.debug(`copyFile: about to start right.writeFile`);
  return {
    entity: await right.writeFile(
      key,
      content,
      statsLeft.mtimeCli,
      statsLeft.mtimeCli /* TODO */
    ),
    content: content,
  };
}

export async function copyFileOrFolder(
  key: string,
  left: FakeFs,
  right: FakeFs
) {
  if (key.endsWith("/")) {
    return await copyFolder(key, left, right);
  } else {
    return await copyFile(key, left, right);
  }
}
