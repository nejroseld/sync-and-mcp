import type { MountConfig, ObsiSettings } from "./settings";
import { validateMounts } from "./settings";
import { normalizeMountPath } from "./sync/mounts";

const FORMAT = "obsi-sync-device-adder";
const VERSION = 1;

export interface DeviceAdder {
  serverUrl: string;
  deviceToken: string;
  mounts: MountConfig[];
}

const validServerUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const validateAdder = (data: DeviceAdder): void => {
  if (!validServerUrl(data.serverUrl)) throw new Error("invalid device-adder serverUrl");
  if (typeof data.deviceToken !== "string" || data.deviceToken.trim() === "") {
    throw new Error("device-adder requires a deviceToken");
  }
  if (!Array.isArray(data.mounts) || data.mounts.length === 0) {
    throw new Error("device-adder requires at least one mount");
  }
  for (const mount of data.mounts) {
    if (!mount || typeof mount.path !== "string") throw new Error("mount path must be a string");
    if (typeof mount.vaultId !== "string" || mount.vaultId.trim() === "") {
      throw new Error("mount requires a vaultId");
    }
    if (mount.vaultName !== undefined && typeof mount.vaultName !== "string") {
      throw new Error("mount vaultName must be a string");
    }
    if (typeof mount.password !== "string" || mount.password.trim() === "") {
      throw new Error("mount requires a password");
    }
    if (mount.encryptionMethod !== "rclone-base64") {
      throw new Error("mount uses an unsupported encryption method");
    }
  }
  const problems = validateMounts(data.mounts);
  if (problems.length) throw new Error(problems.join("; "));
};

/** Create a portable, versioned credential bundle for adding this vault on another device. */
export const createDeviceAdder = (settings: ObsiSettings): string => {
  const payload: DeviceAdder = {
    serverUrl: settings.serverUrl,
    deviceToken: settings.deviceToken,
    mounts: settings.mounts.map((mount) => ({
      path: normalizeMountPath(mount.path),
      vaultId: mount.vaultId,
      vaultName: mount.vaultName ?? "",
      password: mount.password,
      encryptionMethod: mount.encryptionMethod,
    })),
  };
  validateAdder(payload);
  return JSON.stringify({ format: FORMAT, version: VERSION, ...payload }, null, 2);
};

/** Parse and validate a device-adder bundle. Unknown top-level settings are discarded. */
export const parseDeviceAdder = (text: string): DeviceAdder => {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid device-adder JSON");
  }
  if (value?.format !== FORMAT || value?.version !== VERSION) {
    throw new Error("unsupported device-adder format or version");
  }
  if (!Array.isArray(value.mounts)) throw new Error("device-adder mounts must be an array");
  const mounts: MountConfig[] = value.mounts.map((mount: any) => {
    if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
      throw new Error("invalid device-adder mount");
    }
    return {
      path: typeof mount.path === "string" ? normalizeMountPath(mount.path) : mount.path,
      vaultId: mount.vaultId,
      vaultName: mount.vaultName,
      password: mount.password,
      encryptionMethod: mount.encryptionMethod,
    } as MountConfig;
  });
  const result = { serverUrl: value.serverUrl, deviceToken: value.deviceToken, mounts } as DeviceAdder;
  validateAdder(result);
  return result;
};
