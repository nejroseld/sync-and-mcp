import { expect } from "chai";
import { deviceNameFromSystem, randomDeviceName } from "../src/deviceName";

describe("device names", () => {
  it("builds a short random placeholder", () => {
    expect(randomDeviceName(() => 0)).to.equal("Device 0000");
    expect(randomDeviceName(() => 0.5)).to.equal("Device 8000");
  });

  it("uses the system, and the model only when the user agent has one", () => {
    expect(deviceNameFromSystem({ mac: true })).to.equal("Mac");
    expect(deviceNameFromSystem({ windows: true })).to.equal("Windows");
    expect(deviceNameFromSystem({ linux: true })).to.equal("Linux");
    expect(deviceNameFromSystem({ ios: true })).to.equal("iPhone");
    expect(deviceNameFromSystem({ ios: true, userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" })).to.equal("iPad");
    expect(
      deviceNameFromSystem({
        android: true,
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36",
      })
    ).to.equal("Pixel 7");
    expect(deviceNameFromSystem({ android: true, userAgent: "Mozilla/5.0 (Linux; Android 13; wv)" })).to.equal("Android");
    expect(deviceNameFromSystem({})).to.equal(undefined);
  });
});