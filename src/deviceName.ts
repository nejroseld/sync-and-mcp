/** Facts we can actually see. Missing fields mean "unknown", not a guess. */
export interface DeviceFacts {
  ios?: boolean;
  android?: boolean;
  mac?: boolean;
  windows?: boolean;
  linux?: boolean;
  mobile?: boolean;
  tablet?: boolean;
  userAgent?: string;
}

/** Placeholder used on the QR until the new device can name itself. */
export const randomDeviceName = (rand: () => number = Math.random): string => {
  const n = Math.floor(rand() * 65536)
    .toString(16)
    .padStart(4, "0");
  return `Device ${n}`;
};

/**
 * Android WebView: "Android 14; Pixel 7" or "Android 13; SM-S918B".
 * Returns the model token only, and only when it is present.
 */
const androidModel = (ua: string): string | undefined => {
  const m = ua.match(/Android\s[\d.]+;\s*([^;)]+?)\s*(?:Build\/|[);])/i);
  if (!m) return undefined;
  const model = m[1].trim();
  // "wv" is the WebView placeholder, not a device model.
  if (!model || /^(linux|android|wv|mobile)$/i.test(model) || model.length > 40) return undefined;
  return model;
};

/**
 * A short name from the OS and, when the user agent includes it, the model.
 * Undefined when nothing reliable is available — the caller keeps the random name.
 */
export const deviceNameFromSystem = (facts: DeviceFacts): string | undefined => {
  const ua = facts.userAgent ?? "";
  let name: string | undefined;
  if (facts.ios || /iPhone|iPad|iPod/.test(ua)) {
    if (/iPad/.test(ua)) name = "iPad";
    else if (/iPod/.test(ua)) name = "iPod";
    else if (/iPhone/.test(ua)) name = "iPhone";
    else if (facts.ios && facts.tablet) name = "iPad";
    else if (facts.ios) name = "iPhone";
  } else if (facts.android || /Android/.test(ua)) {
    name = androidModel(ua) ?? (facts.android || /Android/.test(ua) ? "Android" : undefined);
  } else if (facts.mac) {
    name = "Mac";
  } else if (facts.windows) {
    name = "Windows";
  } else if (facts.linux) {
    name = "Linux";
  } else if (facts.mobile) {
    name = "Phone";
  }
  if (!name) return undefined;
  return name.slice(0, 64);
};
