import cloneDeep from "lodash/cloneDeep";
import type { Entity } from "./baseTypes";

/**
 * Storage of "previous sync" records, keyed by a state id (we use the server vaultId,
 * so every mount has its own independent history).
 * (obsi-mcp original code; replaces the localforage-based localdb.ts of Remotely Save.)
 */
export interface PrevSyncStore {
  getAll(stateId: string): Promise<Entity[]>;
  upsert(stateId: string, entity: Entity): Promise<void>;
  clear(stateId: string, key: string): Promise<void>;
  clearAll(stateId: string): Promise<void>;
}

export class MemoryPrevSyncStore implements PrevSyncStore {
  data: Record<string, Record<string, Entity>> = {};
  async getAll(stateId: string) {
    return Object.values(this.data[stateId] ?? {}).map((x) => cloneDeep(x));
  }
  async upsert(stateId: string, entity: Entity) {
    if (entity.key === undefined) {
      throw Error("prev sync entity without key");
    }
    (this.data[stateId] ??= {})[entity.key] = cloneDeep(entity);
  }
  async clear(stateId: string, key: string) {
    delete this.data[stateId]?.[key];
  }
  async clearAll(stateId: string) {
    delete this.data[stateId];
  }
}
