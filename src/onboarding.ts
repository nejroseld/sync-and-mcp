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

/** The server rejects shorter account passwords; checked before the request for a quicker hint. */
export const MIN_ACCOUNT_PASSWORD = 12;

/**
 * An invitation is forwarded as free text ("Server: https://…  Code: inv_…"); a bare code works too.
 * Returns what could be found; the wizard fills the matching fields.
 */
export const parseInvitation = (text: string): { serverUrl?: string; code?: string } => {
  const url = text.match(/https?:\/\/[^\s<>"'«»“”]+/i)?.[0].replace(/[.,;:!?)\]]+$/, "");
  const code = text.match(/\binv_[A-Za-z0-9_-]+/)?.[0] ?? (/^\S+$/.test(text.trim()) && !url ? text.trim() : undefined);
  return { serverUrl: url ? normalizeServerUrl(url) : undefined, code };
};

export type AccountProblem = "bad_credentials" | "bad_invite" | "username_taken" | "bad_username" | "weak_password";

/** Account errors the user can fix in the form; anything else is a connection problem. */
export const accountProblem = (e: unknown): AccountProblem | undefined => {
  if (!(e instanceof ApiError)) return undefined;
  return ({
    invalid_credentials: "bad_credentials",
    invalid_invite: "bad_invite",
    username_taken: "username_taken",
    invalid_username: "bad_username",
    weak_password: "weak_password",
  } as const)[e.code];
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
