import { deleteStoredFile, getStoredFile } from "../core/database.js";
import {
  checkProvider,
  clearProviderHealth,
  formatDescriptor,
  getConversionCandidates,
  getPairStatus,
  getProviderDefinitions,
  getTargetsForSource,
  providerHealthActive,
  recordProviderFailure,
  refreshCapabilities
} from "../core/provider-manager.js";
import {
  DEFAULT_SETTINGS,
  getSettings,
  QUEUE_KEY,
  resetAppearance,
  saveSettings
} from "../core/settings.js";
import { outputName, statusErrorSummary } from "../core/utils.js";

const ALARM_NAME = "ufc-process-queue";
const ACTIVE_STAGES = new Set(["uploading", "converting", "downloading"]);
const STALE_AFTER_MS = 45_000;
let processorRunning = false;

async function getQueue() {
  const result = await chrome.storage.local.get(QUEUE_KEY);
  return Array.isArray(result[QUEUE_KEY]) ? result[QUEUE_KEY] : [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function updateItem(id, patch) {
  const queue = await getQueue();
  const index = queue.findIndex(item => item.id === id);
  if (index < 0) return null;
  queue[index] = {
    ...queue[index],
    ...patch,
    updatedAt: Date.now()
  };
  await setQueue(queue);
  return queue[index];
}

async function addItems(items) {
  const queue = await getQueue();
  const existing = new Set(queue.map(item => item.id));
  for (const item of items || []) {
    if (!item?.id || existing.has(item.id)) continue;
    queue.push({
      id: item.id,
      name: String(item.name || "file"),
      size: Number(item.size || 0),
      mimeType: String(item.mimeType || ""),
      source: String(item.source || "").toLowerCase(),
      sourceFormat: formatDescriptor(item.source),
      target: String(item.target || "").toLowerCase(),
      status: "ready",
      progress: 0,
      detail: "Готов к выбору формата",
      provider: "",
      remote: null,
      downloads: [],
      attempts: [],
      error: "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    existing.add(item.id);
  }
  await setQueue(queue);
  return queue;
}

async function removeItem(id) {
  const queue = await getQueue();
  const next = queue.filter(item => item.id !== id);
  await setQueue(next);
  try { await deleteStoredFile(id); } catch {}
  return next;
}

async function clearQueue() {
  const queue = await getQueue();
  await Promise.all(queue.map(item => deleteStoredFile(item.id).catch(() => undefined)));
  await setQueue([]);
}

async function queueForConversion(ids) {
  const idSet = new Set(ids || []);
  const queue = await getQueue();
  let changed = false;
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    if (!idSet.has(item.id)) continue;
    if (!item.target) {
      queue[i] = { ...item, status: "error", error: "Не выбран формат назначения", detail: "Не выбран формат назначения", updatedAt: Date.now() };
      changed = true;
      continue;
    }
    queue[i] = {
      ...item,
      status: "queued",
      progress: 1,
      detail: "В очереди",
      error: "",
      downloads: [],
      updatedAt: Date.now()
    };
    changed = true;
  }
  if (changed) await setQueue(queue);
  processQueue().catch(() => undefined);
}

async function recoverStaleItems() {
  const queue = await getQueue();
  const now = Date.now();
  let changed = false;
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    if (ACTIVE_STAGES.has(item.status) && now - Number(item.updatedAt || 0) > STALE_AFTER_MS) {
      queue[i] = {
        ...item,
        status: "queued",
        detail: item.remote?.jobId ? "Возобновление удалённого задания" : "Повтор после остановки service worker",
        updatedAt: now
      };
      changed = true;
    }
  }
  if (changed) await setQueue(queue);
}

function orderCandidates(candidates, remoteProviderId) {
  return [...candidates].sort((a, b) => {
    if (a.provider.id === remoteProviderId) return -1;
    if (b.provider.id === remoteProviderId) return 1;
    const aCooling = providerHealthActive(a.health);
    const bCooling = providerHealthActive(b.health);
    if (aCooling !== bCooling) return aCooling ? 1 : -1;
    return a.provider.priority - b.provider.priority;
  });
}

function attemptEntry(provider, status, detail = "") {
  return {
    provider: provider.id,
    providerName: provider.name,
    status,
    detail: String(detail || "").slice(0, 700),
    at: Date.now()
  };
}

async function appendAttempt(itemId, entry) {
  const queue = await getQueue();
  const index = queue.findIndex(item => item.id === itemId);
  if (index < 0) return;
  const attempts = Array.isArray(queue[index].attempts) ? queue[index].attempts.slice(-19) : [];
  attempts.push(entry);
  queue[index] = { ...queue[index], attempts, updatedAt: Date.now() };
  await setQueue(queue);
}

async function downloadResults(item, result, providerName) {
  const downloads = [];
  const files = Array.isArray(result?.files) ? result.files : [];
  if (!files.length) throw new Error(`${providerName} не вернул файл для скачивания`);

  await updateItem(item.id, {
    status: "downloading",
    progress: 92,
    detail: "Запуск автоматического скачивания"
  });

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const fallback = files.length === 1
      ? outputName(item.name, item.target)
      : `${item.name.replace(/\.[^.]+$/, "")}-${index + 1}.${item.target}`;
    const filename = String(file.filename || fallback).replace(/[\\/:*?"<>|]/g, "_");
    const downloadId = await chrome.downloads.download({
      url: file.url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    downloads.push({ id: downloadId, filename, url: file.url });
  }
  return downloads;
}

async function processOne(item) {
  const settings = await getSettings();
  if (!settings.onlineEnabled) {
    await updateItem(item.id, {
      status: "error",
      progress: 0,
      error: "Онлайн-конвертация отключена в Settings → Privacy",
      detail: "Онлайн-конвертация отключена"
    });
    return;
  }

  const file = await getStoredFile(item.id);
  if (!file) {
    await updateItem(item.id, {
      status: "error",
      progress: 0,
      error: "Исходный файл больше недоступен. Добавьте его в очередь заново.",
      detail: "Файл не найден"
    });
    return;
  }

  const { status, candidates } = await getConversionCandidates(item.source, item.target);
  if (!candidates.length) {
    await updateItem(item.id, {
      status: "error",
      progress: 0,
      error: status.reason,
      detail: status.reason
    });
    return;
  }

  const ordered = orderCandidates(candidates, item.remote?.provider);
  const errors = [];
  let attemptedCount = 0;

  for (const candidate of ordered) {
    const provider = candidate.provider;
    const apiKey = String(candidate.config?.apiKey || "").trim();
    const resume = item.remote?.provider === provider.id ? item.remote : null;
    const coolingDown = providerHealthActive(candidate.health);

    if (coolingDown && !resume) {
      const until = new Date(Number(candidate.health.cooldownUntil || 0)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const skipped = `${provider.name}: временно пропущен до ${until} после ошибки ${candidate.health.kind || "API"}`;
      errors.push(skipped);
      await appendAttempt(item.id, attemptEntry(provider, "skipped", skipped));
      continue;
    }

    attemptedCount += 1;
    await appendAttempt(item.id, attemptEntry(provider, "started", resume ? "Возобновление удалённого задания" : "Начало конвертации"));

    try {
      await updateItem(item.id, {
        status: resume ? "converting" : "uploading",
        progress: resume ? 45 : 5,
        detail: resume ? `Возобновление ${provider.name}` : `Выбран ${provider.name}`,
        provider: provider.id,
        error: ""
      });

      const result = await provider.convert({
        file,
        source: item.source,
        target: item.target,
        apiKey,
        remote: resume,
        onState: async state => {
          const patch = {
            status: state.stage || "converting",
            progress: Number.isFinite(state.progress) ? state.progress : 50,
            detail: state.detail || provider.name,
            provider: provider.id
          };
          if (state.remote) patch.remote = state.remote;
          await updateItem(item.id, patch);
        }
      });

      await clearProviderHealth(provider.id);
      await appendAttempt(item.id, attemptEntry(provider, "success", "Конвертация завершена"));
      const downloads = await downloadResults(item, result, provider.name);
      await updateItem(item.id, {
        status: "done",
        progress: 100,
        detail: "Готово — скачивание началось автоматически",
        provider: provider.id,
        remote: result.remote || null,
        downloads,
        error: ""
      });
      await deleteStoredFile(item.id).catch(() => undefined);
      return;
    } catch (error) {
      const summary = statusErrorSummary(error);
      const health = await recordProviderFailure(provider.id, error);
      errors.push(`${provider.name}: ${summary}`);
      await appendAttempt(item.id, attemptEntry(provider, "failed", summary));

      const remaining = ordered.filter(next => next.provider.id !== provider.id && !providerHealthActive(next.health));
      const nextName = remaining[0]?.provider?.name || "следующий совместимый API";
      const cooldownText = providerHealthActive(health)
        ? ` ${provider.name} временно исключён из очереди.`
        : "";

      await updateItem(item.id, {
        detail: `${provider.name} завершился ошибкой.${cooldownText} Автоматически переключаюсь на ${nextName}.`,
        error: summary,
        remote: null
      });

      if (!settings.automaticFallback) break;
    }
  }

  const coolingCandidates = ordered.filter(candidate => providerHealthActive(candidate.health));
  const cooldownHint = attemptedCount === 0 && coolingCandidates.length
    ? " Все совместимые API сейчас временно в cooldown; они будут снова доступны после истечения таймера или успешной проверки ключа."
    : "";

  await updateItem(item.id, {
    status: "error",
    progress: 0,
    detail: settings.automaticFallback
      ? "Все доступные совместимые providers завершились ошибкой"
      : "Автоматический fallback отключён",
    error: `${errors.join(" | ").slice(0, 1500)}${cooldownHint}`.slice(0, 1800),
    remote: null
  });
}
async function processQueue() {
  if (processorRunning) return;
  processorRunning = true;
  try {
    await recoverStaleItems();
    while (true) {
      const queue = await getQueue();
      const next = queue.find(item => item.status === "queued");
      if (!next) break;
      await processOne(next);
    }
  } finally {
    processorRunning = false;
  }
}

async function initialize() {
  const current = await getSettings();
  await saveSettings(current || DEFAULT_SETTINGS);
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  }
  await recoverStaleItems();
  processQueue().catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch(() => undefined);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) processQueue().catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case "GET_STATE":
        return {
          settings: await getSettings(),
          queue: await getQueue(),
          providers: await getProviderDefinitions()
        };
      case "GET_TARGETS":
        return getTargetsForSource(message.source, { force: Boolean(message.force) });
      case "GET_PAIR_STATUS":
        return getPairStatus(message.source, message.target, { force: Boolean(message.force) });
      case "ADD_ITEMS":
        return addItems(message.items);
      case "UPDATE_ITEM":
        return updateItem(message.id, message.patch || {});
      case "REMOVE_ITEM":
        return removeItem(message.id);
      case "CLEAR_QUEUE":
        await clearQueue();
        return [];
      case "START_CONVERSIONS":
        await queueForConversion(message.ids || []);
        return { ok: true };
      case "SAVE_SETTINGS": {
        const before = await getSettings();
        const saved = await saveSettings(message.settings || {});
        for (const id of Object.keys(saved.providers || {})) {
          const previous = before.providers?.[id] || {};
          const current = saved.providers?.[id] || {};
          if (String(previous.apiKey || "") !== String(current.apiKey || "") || previous.enabled !== current.enabled) {
            await clearProviderHealth(id);
          }
        }
        return saved;
      }
      case "RESET_APPEARANCE":
        return resetAppearance();
      case "CHECK_PROVIDER":
        return checkProvider(message.providerId);
      case "REFRESH_CAPABILITIES":
        await refreshCapabilities();
        return { ok: true };
      default:
        throw new Error(`Unknown message type: ${message?.type}`);
    }
  };

  run().then(
    result => sendResponse({ ok: true, result }),
    error => sendResponse({ ok: false, error: statusErrorSummary(error) })
  );
  return true;
});

initialize().catch(() => undefined);
