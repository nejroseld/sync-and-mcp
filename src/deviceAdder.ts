import type { MountConfig, ObsiSettings } from "./settings";
import { validateMounts } from "./settings";
import { normalizeMountPath } from "./sync/mounts";

const FORMAT = "obsi-sync-device-adder";
const VERSION = 1;

export interface DeviceAdder {
  serverUrl: string;
  deviceToken: string;
  mounts: MountConfig[];
  /**
   * The token name was generated here because the QR was created without a name.
   * The new device should replace it with its system/model name when it can.
   */
  provisionalDeviceName?: boolean;
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface LooseMount {
  path: unknown;
  vaultId: unknown;
  vaultName?: unknown;
  password: unknown;
  encryptionMethod: unknown;
}

const checkedMounts = (mounts: readonly LooseMount[]): MountConfig[] => {
  if (mounts.length === 0) throw new Error("device-adder requires at least one mount");
  return mounts.map((mount) => {
    if (typeof mount.path !== "string") throw new Error("mount path must be a string");
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
    return {
      path: mount.path,
      vaultId: mount.vaultId,
      vaultName: typeof mount.vaultName === "string" ? mount.vaultName : undefined,
      password: mount.password,
      encryptionMethod: "rclone-base64",
    };
  });
};

const validateAdder = (data: DeviceAdder): void => {
  if (!validServerUrl(data.serverUrl)) throw new Error("invalid device-adder serverUrl");
  if (typeof data.deviceToken !== "string" || data.deviceToken.trim() === "") {
    throw new Error("device-adder requires a deviceToken");
  }
  const mounts = checkedMounts(data.mounts);
  const problems = validateMounts(mounts);
  if (problems.length) throw new Error(problems.join("; "));
};

/** Create a portable, versioned credential bundle for adding this vault on another device. */
export const createDeviceAdder = (settings: ObsiSettings, opts?: { provisionalDeviceName?: boolean }): string => {
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
  return JSON.stringify(
    {
      format: FORMAT,
      version: VERSION,
      ...(opts?.provisionalDeviceName ? { provisionalDeviceName: true } : {}),
      ...payload,
    },
    null,
    2
  );
};

/** Parse and validate a device-adder bundle. Unknown top-level settings are discarded. */
export const parseDeviceAdder = (text: string): DeviceAdder => {
  let value: unknown;
  try {
    // `JSON.parse` is typed as `any`; this only erases that so the value is checked below.
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid device-adder JSON");
  }
  if (!isRecord(value) || value.format !== FORMAT || value.version !== VERSION) {
    throw new Error("unsupported device-adder format or version");
  }
  if (!Array.isArray(value.mounts)) throw new Error("device-adder mounts must be an array");
  const loose: LooseMount[] = value.mounts.map((mount) => {
    if (!isRecord(mount)) throw new Error("invalid device-adder mount");
    return {
      path: typeof mount.path === "string" ? normalizeMountPath(mount.path) : mount.path,
      vaultId: mount.vaultId,
      vaultName: mount.vaultName,
      password: mount.password,
      encryptionMethod: mount.encryptionMethod,
    };
  });
  const serverUrl = value.serverUrl;
  const deviceToken = value.deviceToken;
  if (!validServerUrl(serverUrl)) throw new Error("invalid device-adder serverUrl");
  if (typeof deviceToken !== "string" || deviceToken.trim() === "") {
    throw new Error("device-adder requires a deviceToken");
  }
  const mounts = checkedMounts(loose);
  const result: DeviceAdder = { serverUrl, deviceToken, mounts };
  if (value.provisionalDeviceName === true) result.provisionalDeviceName = true;
  const problems = validateMounts(mounts);
  if (problems.length) throw new Error(problems.join("; "));
  return result;
};
