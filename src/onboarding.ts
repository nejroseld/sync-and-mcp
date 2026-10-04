import { ApiError } from "./api/client";
import type { FakeFs } from "./sync/fsAll";
import { FakeFsEncrypt } from "./sync/fsEncrypt";

/**
 * Forgiving server address: trims, drops trailing slashes and a pasted `/api/v1`, and adds a scheme
 * when missing (http for localhost and IP addresses, https otherwise). Returns "" for empty input.
 */
export const normalizeServerUrl = (input: string): string => {
  let url = input.trim();
  if (url === "") return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const host = url.split(/[/:]/)[0].toLowerCase();
    const local = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
    url = `${local ? "http" : "https"}://${url}`;
  }
  return url.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
};

export type ConnectProblem = "bad_url" | "unreachable" | "bad_token" | "server_error";

/** Classifies a failed connection check so the welcome window can say what to fix. */
export const connectProblem = (e: unknown): ConnectProblem => {
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 403) return "bad_token";
    if (e.status === 404) return "bad_url";
    return "server_error";
  }
  const msg = String(e instanceof Error ? e.message : e);
  if (/invalid url|failed to parse url|unsupported protocol/i.test(msg)) return "bad_url";
  return "unreachable";
};

export type PasswordCheck = "empty_vault" | "match" | "mismatch";

/** Checks an encryption password against what is already stored in a server vault. */
export const checkVaultPassword = async (remote: FakeFs, password: string): Promise<PasswordCheck> => {
  // listing errors (offline, bad token) propagate; only decryption failures mean a wrong password
  if ((await remote.walkPartial()).length === 0) return "empty_vault";
  const enc = new FakeFsEncrypt(remote, password, "rclone-base64");
  try {
    return (await enc.isPasswordOk()).ok ? "match" : "mismatch";
  } catch {
    return "mismatch";
  } finally {
    await enc.closeResources();
  }
};
