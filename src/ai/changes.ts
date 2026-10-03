/**
 * Pure decision logic for applying pending MCP changes on the client.
 */
import type { AckStatus, PendingChange } from "../api/types";
import { isNotePath } from "./rules";

export interface LocalFileState {
  exists: boolean;
  /** sha256 of the current local bytes (only if exists) */
  sha?: string;
}

export interface ChangeDecision {
  action: "apply" | "ack_only";
  status: AckStatus;
  message?: string;
}

/** relative path sanity: no traversal, no hidden/config segments */
export const isSafeRelPath = (p: string): boolean => {
  if (p === "" || p.startsWith("/") || p.includes("\\")) return false;
  const parts = p.split("/");
  return !parts.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."));
};

export interface DecideInput {
  change: Pick<PendingChange, "op" | "path" | "base_version">;
  local: LocalFileState;
  /** true if the path is allowed by AI rules (checked by caller, also against the new content) */
  allowed: boolean;
  /** true if the file belongs to the vault this change was fetched for */
  ownedByThisVault: boolean;
}

export const decideChange = (i: DecideInput): ChangeDecision => {
  if (!isSafeRelPath(i.change.path)) {
    return { action: "ack_only", status: "rejected", message: "unsafe path" };
  }
  if (!isNotePath(i.change.path)) {
    return { action: "ack_only", status: "rejected", message: "only .md notes can be written" };
  }
  if (!i.ownedByThisVault) {
    return {
      action: "ack_only",
      status: "rejected",
      message: "path belongs to another mounted vault on this device",
    };
  }
  if (!i.allowed) {
    return {
      action: "ack_only",
      status: "rejected",
      message: "path is not allowed by the AI rules on this device",
    };
  }
  if (i.change.op === "create") {
    if (i.local.exists) {
      return { action: "ack_only", status: "conflict", message: "file already exists" };
    }
    return { action: "apply", status: "applied" };
  }
  // update
  if (!i.local.exists) {
    return { action: "ack_only", status: "conflict", message: "file no longer exists" };
  }
  if (i.change.base_version !== i.local.sha) {
    return {
      action: "ack_only",
      status: "conflict",
      message: "local version differs from base_version",
    };
  }
  return { action: "apply", status: "applied" };
};

/** text between the leading --- lines, or undefined */
export const extractFrontmatterText = (content: string): string | undefined => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  return m ? m[1] : undefined;
};
