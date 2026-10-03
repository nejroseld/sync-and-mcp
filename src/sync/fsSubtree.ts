import type { Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";
import { isPathInside, normalizeMountPath } from "./mounts";

/**
 * Shows only the subtree `prefix` of an inner FakeFs (keys become relative to the prefix)
 * and hides nested mounts (`excludePrefixes`, vault-absolute). Keys that leave the
 * subtree or point into a nested mount are rejected on write/read.
 * Hidden folders such as ".obsi" need no special handling here: for the root mount
 * they pass through as ordinary keys (the sync engine's allowedHiddenDirs lets them in).
 * (obsi-mcp original code.)
 */
export class FakeFsSubtree extends FakeFs {
  kind: string;
  readonly prefix: string; // "" or "a/b"
  readonly excludes: string[];

  constructor(
    public inner: FakeFs,
    prefix: string,
    excludePrefixes: string[]
  ) {
    super();
    this.prefix = normalizeMountPath(prefix);
    this.excludes = excludePrefixes.map(normalizeMountPath).filter((x) => x !== "");
    this.kind = `subtree(${this.prefix || "/"},${inner.kind})`;
  }

  /** subtree key -> inner key */
  private up(key: string) {
    return this.prefix === "" ? key : `${this.prefix}/${key}`;
  }

  /** inner key -> subtree key, undefined if outside the subtree, excluded, or the subtree root itself */
  private down(innerKey: string): string | undefined {
    let rel: string;
    if (this.prefix === "") {
      rel = innerKey;
    } else {
      if (!innerKey.startsWith(`${this.prefix}/`)) {
        return undefined;
      }
      rel = innerKey.slice(this.prefix.length + 1);
      if (rel === "") {
        return undefined;
      }
    }
    if (this.isExcludedInner(innerKey)) {
      return undefined;
    }
    return rel;
  }

  private isExcludedInner(innerKey: string) {
    const bare = innerKey.endsWith("/") ? innerKey.slice(0, -1) : innerKey;
    return this.excludes.some((ex) => isPathInside(bare, ex));
  }

  private guard(key: string) {
    if (key.startsWith("/") || key.split("/").includes("..")) {
      throw Error(`bad key for subtree: ${key}`);
    }
    if (this.isExcludedInner(this.up(key))) {
      throw Error(`${key} belongs to a nested mount, refusing to touch it`);
    }
    return this.up(key);
  }

  private mapEntity(e: Entity): Entity {
    const rel = this.down(e.key!)!;
    return { ...e, key: rel, keyRaw: rel };
  }

  async walk(): Promise<Entity[]> {
    const res: Entity[] = [];
    for (const e of await this.inner.walk()) {
      if (e.key === undefined || this.down(e.key) === undefined) {
        continue;
      }
      res.push(this.mapEntity(e));
    }
    return res;
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const e = await this.inner.stat(this.guard(key));
    return this.mapEntity(e);
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    return this.mapEntity(await this.inner.mkdir(this.guard(key), mtime, ctime));
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    return this.mapEntity(
      await this.inner.writeFile(this.guard(key), content, mtime, ctime)
    );
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    return await this.inner.readFile(this.guard(key));
  }

  async rename(key1: string, key2: string): Promise<void> {
    return await this.inner.rename(this.guard(key1), this.guard(key2));
  }

  async rm(key: string): Promise<void> {
    return await this.inner.rm(this.guard(key));
  }

  async checkConnect(callbackFunc?: any): Promise<boolean> {
    return await this.inner.checkConnect(callbackFunc);
  }

  async getUserDisplayName(): Promise<string> {
    return await this.inner.getUserDisplayName();
  }

  async revokeAuth(): Promise<any> {
    return await this.inner.revokeAuth();
  }

  allowEmptyFile(): boolean {
    return this.inner.allowEmptyFile();
  }
}
