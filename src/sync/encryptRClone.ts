/*
 * Forked from Remotely Save (https://github.com/remotely-save/remotely-save),
 * file src/encryptRClone.ts at commit adacda7ee5cf95cfaeb646bb4a0862925e9a4d02 (9f67d41^),
 * the last Apache-2.0 version of the sync engine.
 * Copyright (c) fyears and Remotely Save contributors. Licensed under the Apache License, Version 2.0.
 *
 * Modified by obsi-mcp: the Web Worker pool is removed; encryption runs on the calling thread via @fyears/rclone-crypt (works on mobile and under Node). Public method names are kept so fsEncrypt.ts is unchanged.
 */

import {
  Cipher as CipherRCloneCryptPack,
  encryptedSize,
} from "@fyears/rclone-crypt";

export const getSizeFromOrigToEnc = encryptedSize;

export class CipherRclone {
  readonly password: string;
  readonly cipher: CipherRCloneCryptPack;
  private initPromise: Promise<void> | undefined;

  // second arg (worker count) is kept for source compatibility and ignored.
  constructor(password: string, _workerNum?: number) {
    this.password = password;
    this.cipher = new CipherRCloneCryptPack("base64");
  }

  closeResources() {
    // nothing to release without workers
  }

  async prepareByCallingWorker(): Promise<void> {
    if (this.initPromise === undefined) {
      this.initPromise = this.cipher.key(this.password, "").then(() => {});
    }
    await this.initPromise;
  }

  async encryptNameByCallingWorker(inputName: string): Promise<string> {
    await this.prepareByCallingWorker();
    return await this.cipher.encryptFileName(inputName);
  }

  async decryptNameByCallingWorker(inputName: string): Promise<string> {
    await this.prepareByCallingWorker();
    return await this.cipher.decryptFileName(inputName);
  }

  async encryptContentByCallingWorker(
    input: ArrayBuffer
  ): Promise<ArrayBuffer> {
    await this.prepareByCallingWorker();
    const res = await this.cipher.encryptData(new Uint8Array(input), undefined);
    return res.buffer.slice(
      res.byteOffset,
      res.byteOffset + res.byteLength
    ) as ArrayBuffer;
  }

  async decryptContentByCallingWorker(
    input: ArrayBuffer
  ): Promise<ArrayBuffer> {
    await this.prepareByCallingWorker();
    const res = await this.cipher.decryptData(new Uint8Array(input));
    return res.buffer.slice(
      res.byteOffset,
      res.byteOffset + res.byteLength
    ) as ArrayBuffer;
  }
}
