import { BUNDLED_CREDENTIALS_VERSION, BUNDLED_PROVIDER_KEYS } from "./provider-secrets.js";

export const SETTINGS_KEY = "ufcSettings";
export const PROVIDER_STATUS_KEY = "ufcProviderStatus";
export const PROVIDER_HEALTH_KEY = "ufcProviderHealth";
export const QUEUE_KEY = "ufcQueue";
export const CAPABILITY_CACHE_KEY = "ufcCapabilityCache";

export const DEFAULT_SETTINGS = Object.freeze({
  onlineEnabled: true,
  automaticFallback: true,
  bundledCredentialsVersion: 0,
  appearance: {
    theme: "system",
    accentColor: "#6d5dfc",
    buttonColor: "#5b4cf0",
    backgroundColor: "#f5f6fb",
    radius: 12
  },
  providers: {
    convert3d: { enabled: true, apiKey: "" },
    convertapi: { enabled: true, apiKey: "" },
    cloudconvert: { enabled: true, apiKey: "" },
    freeconvert: { enabled: true, apiKey: "" }
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function seedBundledCredentials(merged, saved = {}) {
  const currentVersion = Number(saved.bundledCredentialsVersion || 0);
  const bundledVersion = Number(BUNDLED_CREDENTIALS_VERSION || 0);
  if (bundledVersion <= 0 || currentVersion >= bundledVersion) {
    merged.bundledCredentialsVersion = Math.max(currentVersion, 0);
    return merged;
  }

  for (const [id, apiKey] of Object.entries(BUNDLED_PROVIDER_KEYS || {})) {
    const key = String(apiKey || "").trim();
    if (!key) continue;
    if (!merged.providers[id]) merged.providers[id] = { enabled: true, apiKey: "" };
    if (!String(merged.providers[id].apiKey || "").trim()) {
      merged.providers[id].apiKey = key;
      merged.providers[id].enabled = true;
    }
  }
  merged.bundledCredentialsVersion = bundledVersion;
  return merged;
}

export function mergeSettings(saved = {}) {
  const merged = clone(DEFAULT_SETTINGS);
  if (typeof saved.onlineEnabled === "boolean") merged.onlineEnabled = saved.onlineEnabled;
  if (typeof saved.automaticFallback === "boolean") merged.automaticFallback = saved.automaticFallback;
  if (saved.appearance && typeof saved.appearance === "object") {
    Object.assign(merged.appearance, saved.appearance);
  }
  if (saved.providers && typeof saved.providers === "object") {
    for (const [id, value] of Object.entries(saved.providers)) {
      if (!merged.providers[id]) merged.providers[id] = { enabled: true, apiKey: "" };
      if (value && typeof value === "object") Object.assign(merged.providers[id], value);
    }
  }
  merged.appearance.radius = Math.max(4, Math.min(22, Number(merged.appearance.radius) || 12));
  return seedBundledCredentials(merged, saved);
}

export async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(settings) {
  const merged = mergeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

export async function patchSettings(patch) {
  const current = await getSettings();
  const next = mergeSettings({
    ...current,
    ...patch,
    appearance: { ...current.appearance, ...(patch.appearance || {}) },
    providers: { ...current.providers, ...(patch.providers || {}) }
  });
  return saveSettings(next);
}

export async function resetAppearance() {
  const settings = await getSettings();
  settings.appearance = clone(DEFAULT_SETTINGS.appearance);
  return saveSettings(settings);
}

export function providerConfigured(settings, id) {
  const provider = settings?.providers?.[id];
  return Boolean(provider?.enabled && String(provider.apiKey || "").trim());
}
