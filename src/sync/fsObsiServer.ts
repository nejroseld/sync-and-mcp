import type { ObsiApi } from "../api/client";
import type { ServerFileObject } from "../api/types";
import type { Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";

const toEntity = (f: ServerFileObject): Entity => {
  const isFolder = f.key.endsWith("/");
  return {
    key: f.key,
    keyRaw: f.key,
    mtimeCli: isFolder ? undefined : f.mtime_cli || undefined,
    mtimeSvr: isFolder ? undefined : f.mtime_svr || undefined,
    size: isFolder ? 0 : f.size,
    sizeRaw: isFolder ? 0 : f.size,
    etag: f.etag,
  };
};

/**
 * FakeFs over the obsi-mcp storage API (docs/API.md, "Sync storage"), one vault.
 * Stores whatever FakeFsEncrypt gives it: opaque (encrypted) keys and bytes.
 * (obsi-mcp original code.)
 */
export class FakeFsObsiServer extends FakeFs {
  kind = "obsi-server";
  constructor(
    public api: ObsiApi,
    public vaultId: string
  ) {
    super();
  }

  async walk(): Promise<Entity[]> {
    const files = await this.api.listFiles(this.vaultId);
    return files.map(toEntity);
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const h = await this.api.headFile(this.vaultId, key);
    if (h === undefined) {
      throw Error(`${key} does not exist on the server`);
    }
    const isFolder = key.endsWith("/");
    const size = Number(h["content-length"] ?? 0);
    return {
      key,
      keyRaw: key,
      mtimeCli: isFolder ? undefined : Number(h["x-mtime-cli"]) || undefined,
      mtimeSvr: isFolder ? undefined : Number(h["x-mtime-svr"]) || undefined,
      size: isFolder ? 0 : size,
      sizeRaw: isFolder ? 0 : size,
      etag: h.etag,
    };
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    if (!key.endsWith("/")) {
      throw Error(`should not call mkdir on ${key}`);
    }
    const now = Date.now();
    const f = await this.api.putFile(
      this.vaultId,
      key,
      new ArrayBuffer(0),
      mtime ?? now,
      ctime ?? now
    );
    return toEntity(f);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    isMarkdown?: boolean
  ): Promise<Entity> {
    const f = await this.api.putFile(this.vaultId, key, content, mtime, ctime, isMarkdown);
    return toEntity(f);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    return await this.api.getFile(this.vaultId, key);
  }

  async rename(key1: string, key2: string, isMarkdown?: boolean): Promise<void> {
    const st = await this.stat(key1);
    const content = await this.readFile(key1);
    await this.writeFile(
      key2,
      content,
      st.mtimeCli ?? Date.now(),
      st.mtimeCli ?? Date.now(),
      isMarkdown
    );
    await this.rm(key1);
  }

  async rm(key: string): Promise<void> {
    await this.api.deleteFile(this.vaultId, key);
  }

  async checkConnect(): Promise<boolean> {
    try {
      await this.api.listFiles(this.vaultId);
      return true;
    } catch {
      return false;
    }
  }

  async getUserDisplayName(): Promise<string> {
    return (await this.api.me()).name;
  }

  async revokeAuth(): Promise<any> {
    throw new Error("Method not implemented.");
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
