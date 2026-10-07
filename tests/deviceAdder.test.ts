import { expect } from "chai";
import { createDeviceAdder, parseDeviceAdder } from "../src/deviceAdder";
import { DEFAULT_SETTINGS } from "../src/settings";

const settings = {
  ...DEFAULT_SETTINGS,
  serverUrl: "https://sync.example.test/base",
  deviceToken: "device-secret",
  adminToken: "admin-secret",
  mounts: [
    { path: "/", vaultId: "v1", vaultName: "Main", password: "vault-secret", encryptionMethod: "rclone-base64" as const },
    { path: "Archive/", vaultId: "v2", password: "another-secret", encryptionMethod: "rclone-base64" as const },
  ],
};

describe("device-adder payload", () => {
  it("round trips credentials and normalized mounts", () => {
    expect(parseDeviceAdder(createDeviceAdder(settings))).to.deep.equal({
      serverUrl: settings.serverUrl,
      deviceToken: settings.deviceToken,
      mounts: [
        { path: "", vaultId: "v1", vaultName: "Main", password: "vault-secret", encryptionMethod: "rclone-base64" },
        { path: "Archive", vaultId: "v2", vaultName: "", password: "another-secret", encryptionMethod: "rclone-base64" },
      ],
    });
  });

  it("contains only the device-adder data, never admin or unrelated settings", () => {
    const text = createDeviceAdder(settings);
    expect(text).to.include('"format": "obsi-sync-device-adder"');
    expect(text).not.to.include("admin-secret");
    expect(text).not.to.include("syncEnabled");
    expect(text).not.to.include('"adminToken"');
  });

  it("rejects malformed structure, credentials, URLs, encryption and duplicate mounts", () => {
    const base = JSON.parse(createDeviceAdder(settings));
    const reject = (mutate: (data: any) => void) => {
      const data = structuredClone(base);
      mutate(data);
      expect(() => parseDeviceAdder(JSON.stringify(data))).to.throw();
    };
    expect(() => parseDeviceAdder("nope")).to.throw();
    reject((d) => (d.version = 2));
    reject((d) => (d.serverUrl = "file:///tmp/vault"));
    reject((d) => (d.deviceToken = "  "));
    reject((d) => (d.mounts = []));
    reject((d) => (d.mounts[0].password = ""));
    reject((d) => (d.mounts[0].encryptionMethod = "unknown"));
    reject((d) => (d.mounts[1].path = "/"));
    reject((d) => (d.mounts[1].vaultId = "v1"));
  });

  it("marks a QR created without a device name so the new device can rename itself", () => {
    const text = createDeviceAdder(settings, { provisionalDeviceName: true });
    const parsed = parseDeviceAdder(text);
    expect(parsed.provisionalDeviceName).to.equal(true);
    expect(parsed.deviceToken).to.equal("device-secret");
    expect(parseDeviceAdder(createDeviceAdder(settings)).provisionalDeviceName).to.equal(undefined);
  });

  it("refuses to create bundles from incomplete settings", () => {
    expect(() => createDeviceAdder({ ...settings, deviceToken: "" })).to.throw();
    expect(() => createDeviceAdder({ ...settings, mounts: [] })).to.throw();
  });
});
