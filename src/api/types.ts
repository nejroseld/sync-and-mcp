/** Types of docs/API.md (client <-> server contract). */

export type TokenKind = "device" | "mcp" | "admin";
export type DeviceOp = "read" | "write";
export type McpOp = "list" | "search" | "read" | "write";

export interface MeInfo {
  token_id: string;
  name: string;
  kind: TokenKind;
  grants: Record<string, string[]>;
  user?: { id: string; username: string };
}

export interface InviteInfo {
  id: string;
  name: string;
  code?: string;
  created_at: number;
  used_at: number | null;
}

export interface VaultInfo {
  id: string;
  name: string;
  created_at: number;
  rag?: { enabled: boolean; chunk_chars?: number; chunk_overlap?: number };
}

export interface TokenInfo {
  id: string;
  name: string;
  kind: TokenKind;
  grants: Record<string, string[]>;
  created_at: number;
  revoked_at: number | null;
  last_used_at?: number | null;
  /** only on creation */
  token?: string;
}

export interface ServerFileObject {
  key: string;
  size: number;
  mtime_cli: number;
  ctime_cli: number;
  mtime_svr: number;
  etag: string;
}

export interface ManifestFile {
  path: string;
  version: string;
  mtime: number;
  size: number;
  kind: "note" | "attachment";
}

export interface PendingChange {
  id: string;
  path: string;
  op: "create" | "update";
  content: string;
  base_version: string | null;
  status: string;
  created_at: number;
  token_name?: string;
}

export type AckStatus = "applied" | "conflict" | "rejected";

export interface EmbeddingSettings {
  base_url: string;
  api_key: string;
  model: string;
}
