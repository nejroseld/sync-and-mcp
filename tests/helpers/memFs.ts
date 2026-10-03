import type { Entity } from "../../src/sync/baseTypes";
import { FakeFs } from "../../src/sync/fsAll";

interface Node {
  content: ArrayBuffer;
  mtime: number;
  ctime: number;
  mtimeSvr: number;
}

export const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
export const str = (b: ArrayBuffer) => new TextDecoder().decode(b);

/**
 * In-memory FakeFs. kind "local": mtimeSvr == mtimeCli, parents are created automatically
 * (like Obsidian's adapter). kind "remote": mtimeSvr is a server clock.
 */
export class MemFs extends FakeFs {
  kind: string;
  nodes = new Map<string, Node>();
  clock = 1_000_000;
  autoParents: boolean;
  constructor(
    kind: "local" | "remote",
    init: Record<string, string | { content: string; mtime: number }> = {}
  ) {
    super();
    this.kind = kind;
    this.autoParents = kind === "local";
    for (const [k, v] of Object.entries(init)) {
      const content = typeof v === "string" ? v : v.content;
      const mtime = typeof v === "string" ? 1000 : v.mtime;
      this.putRaw(k, content, mtime);
    }
  }

  putRaw(key: string, content: string, mtime: number) {
    this.ensureParents(key);
    this.nodes.set(key, {
      content: buf(content),
      mtime,
      ctime: mtime,
      mtimeSvr: this.kind === "local" ? mtime : ++this.clock,
    });
  }

  private ensureParents(key: string) {
    if (!this.autoParents) return;
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = `${parts.slice(0, i).join("/")}/`;
      if (!this.nodes.has(folder)) {
        this.nodes.set(folder, { content: new ArrayBuffer(0), mtime: 0, ctime: 0, mtimeSvr: 0 });
      }
    }
  }

  private entity(key: string, n: Node): Entity {
    const folder = key.endsWith("/");
    return {
      key,
      keyRaw: key,
      mtimeCli: folder ? undefined : n.mtime,
      mtimeSvr: folder ? undefined : n.mtimeSvr,
      size: folder ? 0 : n.content.byteLength,
      sizeRaw: folder ? 0 : n.content.byteLength,
    };
  }

  text(key: string) {
    const n = this.nodes.get(key);
    return n ? str(n.content) : undefined;
  }
  files() {
    return [...this.nodes.keys()].filter((k) => !k.endsWith("/")).sort();
  }
  keys() {
    return [...this.nodes.keys()].sort();
  }

  async walk() {
    return [...this.nodes.entries()].map(([k, n]) => this.entity(k, n));
  }
  async walkPartial() {
    return this.walk();
  }
  async stat(key: string) {
    const n = this.nodes.get(key);
    if (!n) throw Error(`no ${key}`);
    return this.entity(key, n);
  }
  async mkdir(key: string, mtime?: number) {
    this.ensureParents(key);
    this.nodes.set(key, { content: new ArrayBuffer(0), mtime: mtime ?? 0, ctime: 0, mtimeSvr: 0 });
    return this.entity(key, this.nodes.get(key)!);
  }
  async writeFile(key: string, content: ArrayBuffer, mtime: number, ctime: number) {
    this.ensureParents(key);
    this.nodes.set(key, {
      content: content.slice(0),
      mtime,
      ctime,
      mtimeSvr: this.kind === "local" ? mtime : ++this.clock,
    });
    return this.entity(key, this.nodes.get(key)!);
  }
  async readFile(key: string) {
    const n = this.nodes.get(key);
    if (!n) throw Error(`no ${key}`);
    return n.content.slice(0);
  }
  async rename(a: string, b: string) {
    const n = this.nodes.get(a);
    if (!n) throw Error(`no ${a}`);
    this.nodes.delete(a);
    this.nodes.set(b, n);
  }
  async rm(key: string) {
    this.nodes.delete(key);
    if (key.endsWith("/")) {
      for (const k of [...this.nodes.keys()]) if (k.startsWith(key)) this.nodes.delete(k);
    }
  }
  async checkConnect() {
    return true;
  }
  async getUserDisplayName() {
    return "mem";
  }
  async revokeAuth() {}
  allowEmptyFile() {
    return true;
  }
}
