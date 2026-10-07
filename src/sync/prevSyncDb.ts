import type { Entity } from "./baseTypes";
import type { PrevSyncStore } from "./syncDb";

/**
 * IndexedDB-backed PrevSyncStore.
 * Keys: `${stateId}\t${entityKey}`; stateId = server vaultId, so every mount has its own history.
 *
 * Schema matches the previous localforage database so existing installs keep their history:
 * database name is the constructor argument, object store name is `prevsync`, keys are
 * out-of-line strings, and values are the raw Entity objects (`store.put(value, key)`).
 * New databases open at version 1. An existing database is left in place: other object
 * stores are not deleted, and `prevsync` is created only when it is missing.
 * localforage often already stored this data above version 1 (it bumps the version when
 * it creates the store). Opening that database at version 1 throws VersionError, so we
 * reopen it at its current version without recreating the store.
 */
const STORE_NAME = "prevsync";

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: DOMException | null) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error("IndexedDB transaction failed"));
    };
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });

const openPrevSyncDb = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const fail = (error: DOMException | null) => {
      reject(error ?? new Error(`failed to open IndexedDB ${name}`));
    };

    const ensureStore = (db: IDBDatabase) => {
      if (db.objectStoreNames.contains(STORE_NAME)) {
        resolve(db);
        return;
      }
      const nextVersion = db.version + 1;
      db.close();
      const upgrade = indexedDB.open(name, nextVersion);
      upgrade.onupgradeneeded = () => {
        const created = upgrade.result;
        if (!created.objectStoreNames.contains(STORE_NAME)) {
          created.createObjectStore(STORE_NAME);
        }
      };
      upgrade.onsuccess = () => resolve(upgrade.result);
      upgrade.onerror = () => fail(upgrade.error);
    };

    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => ensureStore(request.result);
    request.onerror = (event) => {
      if (request.error?.name !== "VersionError") {
        fail(request.error);
        return;
      }
      // Existing install is already above version 1. Do not delete it.
      event.preventDefault();
      const reopen = indexedDB.open(name);
      reopen.onsuccess = () => ensureStore(reopen.result);
      reopen.onerror = () => fail(reopen.error);
    };
  });

export class LocalForagePrevSyncStore implements PrevSyncStore {
  private readonly dbName: string;
  private connection: Promise<IDBDatabase> | undefined;

  constructor(dbName: string) {
    this.dbName = dbName;
  }

  private database(): Promise<IDBDatabase> {
    if (this.connection === undefined) {
      this.connection = openPrevSyncDb(this.dbName).catch((err: unknown) => {
        this.connection = undefined;
        throw err;
      });
    }
    return this.connection;
  }

  private prefix(stateId: string) {
    return `${stateId}\t`;
  }

  async getAll(stateId: string): Promise<Entity[]> {
    const db = await this.database();
    const prefix = this.prefix(stateId);
    const out: Entity[] = [];
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).openCursor(IDBKeyRange.lowerBound(prefix));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      if (typeof cursor.key !== "string" || !cursor.key.startsWith(prefix)) return;
      out.push(cursor.value);
      cursor.continue();
    };
    await txDone(tx);
    return out;
  }

  async upsert(stateId: string, entity: Entity): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(entity, this.prefix(stateId) + entity.key);
    await txDone(tx);
  }

  async clear(stateId: string, key: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(this.prefix(stateId) + key);
    await txDone(tx);
  }

  async clearAll(stateId: string): Promise<void> {
    const db = await this.database();
    const prefix = this.prefix(stateId);
    const tx = db.transaction(STORE_NAME, "readwrite");
    const request = tx.objectStore(STORE_NAME).openCursor(IDBKeyRange.lowerBound(prefix));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      if (typeof cursor.key !== "string" || !cursor.key.startsWith(prefix)) return;
      cursor.delete();
      cursor.continue();
    };
    await txDone(tx);
  }
}
