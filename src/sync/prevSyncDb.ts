import localforage from "localforage";
import type { Entity } from "./baseTypes";
import type { PrevSyncStore } from "./syncDb";

/**
 * IndexedDB-backed PrevSyncStore (localforage, like Remotely Save did).
 * Keys: `${stateId}\t${entityKey}`; stateId = server vaultId, so every mount has its own history.
 * (obsi-mcp original code.)
 */
export class LocalForagePrevSyncStore implements PrevSyncStore {
  private db: LocalForage;
  constructor(dbName: string) {
    this.db = localforage.createInstance({ name: dbName, storeName: "prevsync" });
  }
  private prefix(stateId: string) {
    return `${stateId}\t`;
  }
  async getAll(stateId: string): Promise<Entity[]> {
    const res: Entity[] = [];
    const p = this.prefix(stateId);
    await this.db.iterate<Entity, void>((value, key) => {
      if (key.startsWith(p)) res.push(value);
    });
    return res;
  }
  async upsert(stateId: string, entity: Entity): Promise<void> {
    await this.db.setItem(this.prefix(stateId) + entity.key, entity);
  }
  async clear(stateId: string, key: string): Promise<void> {
    await this.db.removeItem(this.prefix(stateId) + key);
  }
  async clearAll(stateId: string): Promise<void> {
    const p = this.prefix(stateId);
    const keys = (await this.db.keys()).filter((k) => k.startsWith(p));
    for (const k of keys) await this.db.removeItem(k);
  }
}
