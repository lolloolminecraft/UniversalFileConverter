import { CloudConvertProvider } from "../providers/cloudconvert.js";
import { Convert3DProvider } from "../providers/convert3d.js";
import { ConvertApiProvider } from "../providers/convertapi.js";
import { FreeConvertProvider } from "../providers/freeconvert.js";
import { enrichFormat, getFormat } from "./format-registry.js";
import {
  CAPABILITY_CACHE_KEY,
  getSettings,
  providerConfigured,
  PROVIDER_HEALTH_KEY,
  PROVIDER_STATUS_KEY
} from "./settings.js";
import { normalizeFormat, statusErrorSummary, uniqueFormats } from "./utils.js";

export const PROVIDERS = Object.freeze([
  Convert3DProvider,
  ConvertApiProvider,
  CloudConvertProvider,
  FreeConvertProvider
].sort((a, b) => a.priority - b.priority));

const CACHE_TTL = 6 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function readCache() {
  const result = await chrome.storage.local.get(CAPABILITY_CACHE_KEY);
  return result[CAPABILITY_CACHE_KEY] && typeof result[CAPABILITY_CACHE_KEY] === "object"
    ? result[CAPABILITY_CACHE_KEY]
    : {};
}

async function writeCache(cache) {
  await chrome.storage.local.set({ [CAPABILITY_CACHE_KEY]: cache });
}

async function readHealthStore() {
  const result = await chrome.storage.local.get(PROVIDER_HEALTH_KEY);
  return result[PROVIDER_HEALTH_KEY] && typeof result[PROVIDER_HEALTH_KEY] === "object"
    ? result[PROVIDER_HEALTH_KEY]
    : {};
}

async function writeHealthStore(store) {
  await chrome.storage.local.set({ [PROVIDER_HEALTH_KEY]: store });
}

function cacheKey(providerId, source) {
  return `${providerId}:${normalizeFormat(source)}`;
}

function cooldownFor(error, previousFailures = 0) {
  const code = String(error?.code || "").toUpperCase();
  const status = Number(error?.status || 0);
  const failures = Math.max(0, Number(previousFailures || 0));

  if (code === "AUTH" || status === 401) {
    return { kind: "auth", global: true, duration: 24 * HOUR };
  }
  if (code === "QUOTA_OR_PERMISSION" || status === 402 || status === 403) {
    return { kind: "quota_or_permission", global: true, duration: 6 * HOUR };
  }
  if (status === 429) {
    return { kind: "rate_limit", global: true, duration: Math.min(60 * MINUTE, 5 * MINUTE * Math.pow(2, Math.min(failures, 3))) };
  }
  if (code === "NETWORK") {
    return { kind: "network", global: true, duration: Math.min(15 * MINUTE, MINUTE * Math.pow(2, Math.min(failures, 4))) };
  }
  if (code === "TEMPORARY" || status === 408 || status >= 500) {
    return { kind: "temporary", global: true, duration: Math.min(30 * MINUTE, 2 * MINUTE * Math.pow(2, Math.min(failures, 4))) };
  }
  return { kind: "job_error", global: false, duration: 0 };
}

export function providerHealthActive(health, now = Date.now()) {
  return Boolean(health?.global && Number(health?.cooldownUntil || 0) > now);
}

export async function getProviderHealth(providerId = "") {
  const store = await readHealthStore();
  if (providerId) return store[providerId] || null;
  return store;
}

export async function recordProviderFailure(providerId, error) {
  const store = await readHealthStore();
  const previous = store[providerId] || {};
  const failureCount = Number(previous.failureCount || 0) + 1;
  const policy = cooldownFor(error, failureCount - 1);
  const now = Date.now();
  const entry = {
    failureCount,
    kind: policy.kind,
    global: policy.global,
    lastCode: String(error?.code || "API"),
    lastStatus: Number(error?.status || 0) || 0,
    lastMessage: statusErrorSummary(error),
    lastFailureAt: now,
    cooldownUntil: policy.global ? now + policy.duration : 0
  };
  store[providerId] = entry;
  await writeHealthStore(store);
  return entry;
}

export async function clearProviderHealth(providerId) {
  const store = await readHealthStore();
  if (!(providerId in store)) return;
  delete store[providerId];
  await writeHealthStore(store);
}

export async function clearAllProviderHealth() {
  await chrome.storage.local.remove(PROVIDER_HEALTH_KEY);
}

async function providerTargets(provider, source, force = false) {
  const key = cacheKey(provider.id, source);
  const cache = await readCache();
  const entry = cache[key];
  if (!force && entry && Date.now() - entry.updatedAt < CACHE_TTL && Array.isArray(entry.targets)) {
    return { targets: entry.targets, cached: true, error: entry.error || "" };
  }

  try {
    const targets = uniqueFormats(await provider.getTargets(source));
    cache[key] = { targets, updatedAt: Date.now(), error: "" };
    await writeCache(cache);
    return { targets, cached: false, error: "" };
  } catch (error) {
    const previousTargets = Array.isArray(entry?.targets) ? entry.targets : [];
    cache[key] = {
      targets: previousTargets,
      updatedAt: entry?.updatedAt || 0,
      lastFailureAt: Date.now(),
      error: statusErrorSummary(error)
    };
    await writeCache(cache);
    return { targets: previousTargets, cached: Boolean(previousTargets.length), error: statusErrorSummary(error) };
  }
}

export async function getProviderDefinitions() {
  const settings = await getSettings();
  const storage = await chrome.storage.local.get([PROVIDER_STATUS_KEY, PROVIDER_HEALTH_KEY]);
  const statusStore = storage[PROVIDER_STATUS_KEY] || {};
  const healthStore = storage[PROVIDER_HEALTH_KEY] || {};
  return PROVIDERS.map(provider => ({
    id: provider.id,
    name: provider.name,
    priority: provider.priority,
    enabled: settings.providers?.[provider.id]?.enabled !== false,
    configured: providerConfigured(settings, provider.id),
    requiresApiKey: provider.requiresApiKey,
    freeTier: provider.freeTier,
    retention: provider.retention,
    status: statusStore[provider.id] || null,
    health: healthStore[provider.id] || null,
    coolingDown: providerHealthActive(healthStore[provider.id])
  }));
}

export async function getTargetsForSource(source, { force = false } = {}) {
  const input = normalizeFormat(source);
  const settings = await getSettings();
  if (!input) return { source: input, targets: [], providers: [], onlineEnabled: settings.onlineEnabled };

  const healthStore = await readHealthStore();
  const enabledProviders = PROVIDERS.filter(provider => settings.providers?.[provider.id]?.enabled !== false);
  const results = await Promise.all(enabledProviders.map(async provider => ({
    provider,
    result: await providerTargets(provider, input, force)
  })));

  const targetMap = new Map();
  const providerReports = [];
  for (const { provider, result } of results) {
    providerReports.push({
      id: provider.id,
      name: provider.name,
      error: result.error,
      configured: providerConfigured(settings, provider.id),
      targetCount: result.targets.length,
      health: healthStore[provider.id] || null,
      coolingDown: providerHealthActive(healthStore[provider.id])
    });
    for (const target of result.targets) {
      if (target === input) continue;
      if (!targetMap.has(target)) targetMap.set(target, new Set());
      targetMap.get(target).add(provider.id);
    }
  }

  const targets = [...targetMap.entries()].map(([target, providerIds]) => {
    const configuredIds = [...providerIds].filter(id => providerConfigured(settings, id));
    const healthyConfiguredIds = configuredIds.filter(id => !providerHealthActive(healthStore[id]));
    let availability = "unavailable";
    let reason = "Подходящий API не найден";
    if (!settings.onlineEnabled) {
      availability = "online_disabled";
      reason = "Онлайн-конвертация отключена";
    } else if (healthyConfiguredIds.length) {
      availability = "available";
      reason = `Поддерживается: ${healthyConfiguredIds.map(id => PROVIDERS.find(provider => provider.id === id)?.name || id).join(", ")}`;
    } else if (configuredIds.length) {
      availability = "available";
      reason = `Поддерживается, но API временно в cooldown: ${configuredIds.map(id => PROVIDERS.find(provider => provider.id === id)?.name || id).join(", ")}`;
    } else if (providerIds.size) {
      availability = "requires_key";
      reason = `Требуется API key: ${[...providerIds].map(id => PROVIDERS.find(provider => provider.id === id)?.name || id).join(", ")}`;
    }
    return {
      ...enrichFormat(target, [...providerIds], [{ source: input, target, providers: [...providerIds], available: availability === "available" }]),
      availability,
      reason
    };
  }).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.extension.localeCompare(b.extension);
  });

  return { source: input, targets, providers: providerReports, onlineEnabled: settings.onlineEnabled };
}

export async function getPairStatus(source, target, { force = false } = {}) {
  const input = normalizeFormat(source);
  const output = normalizeFormat(target);
  const settings = await getSettings();
  if (!settings.onlineEnabled) {
    return { source: input, target: output, availability: "online_disabled", reason: "Онлайн-конвертация отключена", providers: [] };
  }
  if (!input || !output || input === output) {
    return { source: input, target: output, availability: "unavailable", reason: "Некорректная пара форматов", providers: [] };
  }

  const healthStore = await readHealthStore();
  const reports = [];
  for (const provider of PROVIDERS) {
    const config = settings.providers?.[provider.id] || { enabled: true, apiKey: "" };
    if (config.enabled === false) {
      reports.push({ id: provider.id, name: provider.name, supported: false, enabled: false, configured: false, reason: "Provider отключён" });
      continue;
    }

    let supported = false;
    let error = "";
    try {
      if (!force) {
        const cached = await providerTargets(provider, input, false);
        if (cached.targets.includes(output)) supported = true;
        else supported = await provider.supportsPair(input, output);
      } else {
        supported = await provider.supportsPair(input, output);
      }
    } catch (err) {
      error = statusErrorSummary(err);
    }
    const health = healthStore[provider.id] || null;
    const coolingDown = providerHealthActive(health);
    reports.push({
      id: provider.id,
      name: provider.name,
      priority: provider.priority,
      supported,
      enabled: true,
      configured: Boolean(String(config.apiKey || "").trim()),
      error,
      health,
      coolingDown,
      reason: supported
        ? (config.apiKey ? (coolingDown ? "Временно пропускается после ошибки" : "Готов") : "Требуется API key")
        : (error || "Пара не поддерживается")
    });
  }

  const ready = reports.filter(item => item.supported && item.configured && !item.coolingDown).sort((a, b) => a.priority - b.priority);
  const cooling = reports.filter(item => item.supported && item.configured && item.coolingDown).sort((a, b) => a.priority - b.priority);
  const needsKey = reports.filter(item => item.supported && !item.configured);
  if (ready.length) {
    return { source: input, target: output, availability: "available", reason: `Поддерживается: ${ready.map(item => item.name).join(", ")}`, providers: reports };
  }
  if (cooling.length) {
    return { source: input, target: output, availability: "available", reason: `API временно недоступны; ProviderManager пропустит cooldown: ${cooling.map(item => item.name).join(", ")}`, providers: reports };
  }
  if (needsKey.length) {
    return { source: input, target: output, availability: "requires_key", reason: `Требуется API key: ${needsKey.map(item => item.name).join(", ")}`, providers: reports };
  }
  const reachableErrors = reports.filter(item => item.error).map(item => `${item.name}: ${item.error}`);
  return {
    source: input,
    target: output,
    availability: "unavailable",
    reason: reachableErrors.length ? `Provider unavailable: ${reachableErrors.join(" | ")}` : "Подходящий API не найден",
    providers: reports
  };
}

export async function getConversionCandidates(source, target) {
  const status = await getPairStatus(source, target);
  if (status.availability !== "available") return { status, candidates: [] };
  const settings = await getSettings();
  const candidates = PROVIDERS
    .filter(provider => {
      const report = status.providers.find(item => item.id === provider.id);
      return report?.supported && providerConfigured(settings, provider.id);
    })
    .map(provider => {
      const report = status.providers.find(item => item.id === provider.id);
      return {
        provider,
        config: settings.providers[provider.id],
        health: report?.health || null,
        coolingDown: Boolean(report?.coolingDown)
      };
    });
  return { status, candidates };
}

export async function checkProvider(providerId) {
  const provider = PROVIDERS.find(item => item.id === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const settings = await getSettings();
  const config = settings.providers?.[providerId] || {};
  const result = await provider.check(config);
  const storage = await chrome.storage.local.get(PROVIDER_STATUS_KEY);
  const statuses = storage[PROVIDER_STATUS_KEY] || {};
  statuses[providerId] = { ...result, checkedAt: Date.now() };
  await chrome.storage.local.set({ [PROVIDER_STATUS_KEY]: statuses });
  if (result.ok) await clearProviderHealth(providerId);
  return statuses[providerId];
}

export async function refreshCapabilities() {
  await chrome.storage.local.remove(CAPABILITY_CACHE_KEY);
}

export function providerById(id) {
  return PROVIDERS.find(provider => provider.id === id) || null;
}

export function formatDescriptor(format) {
  return getFormat(format);
}
