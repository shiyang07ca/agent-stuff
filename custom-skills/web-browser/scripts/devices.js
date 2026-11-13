export const DEVICE_PRESETS = {
  "iphone-se": {
    title: "iPhone SE",
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
  },
  "iphone-14": {
    title: "iPhone 14",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
  },
  "pixel-7": {
    title: "Pixel 7",
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    platform: "Android",
  },
  "galaxy-s20": {
    title: "Galaxy S20",
    width: 360,
    height: 800,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    platform: "Android",
  },
};

export function listDevicePresets() {
  return Object.entries(DEVICE_PRESETS).map(([id, preset]) => ({
    id,
    ...preset,
  }));
}

export function resolveDevicePreset(name) {
  if (!name) return null;
  const normalized = String(name).toLowerCase();
  const preset = DEVICE_PRESETS[normalized];
  if (!preset) return null;
  return { id: normalized, ...preset };
}

export async function applyDevicePreset(cdp, sessionId, preset, options = {}) {
  const landscape = options.landscape === true;
  const width = landscape ? preset.height : preset.width;
  const height = landscape ? preset.width : preset.height;

  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width,
      height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile: true,
      screenOrientation: landscape
        ? { type: "landscapePrimary", angle: 90 }
        : { type: "portraitPrimary", angle: 0 },
    },
    sessionId,
  );

  await cdp.send(
    "Emulation.setTouchEmulationEnabled",
    { enabled: true, maxTouchPoints: 5 },
    sessionId,
  );

  await cdp.send(
    "Emulation.setEmitTouchEventsForMouse",
    { enabled: true, configuration: "mobile" },
    sessionId,
  );

  await cdp.send(
    "Emulation.setUserAgentOverride",
    {
      userAgent: preset.userAgent,
      platform: preset.platform,
      acceptLanguage: "en-US,en",
    },
    sessionId,
  );

  return {
    width,
    height,
    deviceScaleFactor: preset.deviceScaleFactor,
    landscape,
  };
}

export async function clearDeviceEmulation(cdp, sessionId) {
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  if (cdp.extension) {
    // A background extension target keeps its old layout until it paints.
    // A one-pixel capture flushes that layout without activating the user's tab.
    await cdp.send("Page.captureScreenshot", {
      format: "png", clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
    }, sessionId);
  }

  await cdp.send(
    "Emulation.setUserAgentOverride",
    { userAgent: "", platform: "", acceptLanguage: "" },
    sessionId,
  );

  await cdp.send(
    "Emulation.setTouchEmulationEnabled",
    { enabled: false },
    sessionId,
  );

  await cdp.send(
    "Emulation.setEmitTouchEventsForMouse",
    { enabled: false, configuration: "mobile" },
    sessionId,
  );
}
