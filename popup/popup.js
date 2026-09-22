import { putFile } from "../core/database.js";
import {
  CATEGORIES,
  getCategoryForFormat,
  getFormat
} from "../core/format-registry.js";
import { DEFAULT_SETTINGS, mergeSettings } from "../core/settings.js";
import { extensionOf, formatBytes, normalizeFormat } from "../core/utils.js";

const els = {
  app: document.getElementById("app"),
  privacyBanner: document.getElementById("privacyBanner"),
  dropZone: document.getElementById("dropZone"),
  pickFilesBtn: document.getElementById("pickFilesBtn"),
  fileInput: document.getElementById("fileInput"),
  batchControls: document.getElementById("batchControls"),
  globalCategory: document.getElementById("globalCategory"),
  globalTarget: document.getElementById("globalTarget"),
  queueSummary: document.getElementById("queueSummary"),
  clearBtn: document.getElementById("clearBtn"),
  emptyState: document.getElementById("emptyState"),
  fileList: document.getElementById("fileList"),
  providerHint: document.getElementById("providerHint"),
  convertAllBtn: document.getElementById("convertAllBtn"),
  resetAppearanceBtn: document.getElementById("resetAppearanceBtn"),
  themeSelect: document.getElementById("themeSelect"),
  accentColor: document.getElementById("accentColor"),
  buttonColor: document.getElementById("buttonColor"),
  backgroundColor: document.getElementById("backgroundColor"),
  radiusRange: document.getElementById("radiusRange"),
  radiusValue: document.getElementById("radiusValue"),
  providerList: document.getElementById("providerList"),
  refreshCapabilitiesBtn: document.getElementById("refreshCapabilitiesBtn"),
  onlineToggle: document.getElementById("onlineToggle"),
  onlineStatusCopy: document.getElementById("onlineStatusCopy"),
  toast: document.getElementById("toast")
};

const state = {
  settings: mergeSettings(DEFAULT_SETTINGS),
  queue: [],
  providers: [],
  targets: new Map(),
  pairStatus: new Map(),
  loadingTargets: new Set(),
  globalCategory: "images"
};

let toastTimer = null;

function showToast(message) {
  els.toast.textContent = String(message || "");
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Extension service worker error");
  return response.result;
}

function formatSourceFromFile(file) {
  const ext = extensionOf(file.name);
  if (ext) return ext;
  const mime = String(file.type || "").toLowerCase();
  const common = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/json": "json",
    "application/xml": "xml"
  };
  return common[mime] || normalizeFormat(mime.split("/").pop());
}

function applyAppearance() {
  const appearance = state.settings.appearance;
  document.documentElement.style.setProperty("--accent", appearance.accentColor);
  document.documentElement.style.setProperty("--button", appearance.buttonColor);
  document.documentElement.style.setProperty("--background", appearance.backgroundColor);
  document.documentElement.style.setProperty("--radius", `${appearance.radius}px`);

  els.app.classList.remove("dark", "system-theme");
  if (appearance.theme === "dark") els.app.classList.add("dark");
  else if (appearance.theme === "system") els.app.classList.add("system-theme");

  els.themeSelect.value = appearance.theme;
  els.accentColor.value = appearance.accentColor;
  els.buttonColor.value = appearance.buttonColor;
  els.backgroundColor.value = appearance.backgroundColor;
  els.radiusRange.value = String(appearance.radius);
  els.radiusValue.textContent = `${appearance.radius}px`;
}

function setupCategorySelect() {
  els.globalCategory.innerHTML = "";
  for (const category of CATEGORIES) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = category.label;
    els.globalCategory.append(option);
  }
  els.globalCategory.value = state.globalCategory;
}

function targetMapForSource(source) {
  const result = state.targets.get(normalizeFormat(source));
  return new Map((result?.targets || []).map(target => [target.extension, target]));
}

function candidateFormatsForCategory(categoryId, source) {
  const live = state.targets.get(normalizeFormat(source))?.targets || [];
  const byExt = new Map();
  for (const item of live) {
    if (item.category === categoryId) byExt.set(item.extension, item);
  }
  return [...byExt.values()].sort((a, b) => a.extension.localeCompare(b.extension));
}

function availabilityFor(source, target) {
  const input = normalizeFormat(source);
  const output = normalizeFormat(target);
  if (!state.settings.onlineEnabled) {
    return { availability: "online_disabled", reason: "Онлайн-конвертация отключена" };
  }
  const live = targetMapForSource(input).get(output);
  if (live) return live;
  const result = state.targets.get(input);
  if (!result || state.loadingTargets.has(input)) {
    return { availability: "loading", reason: "Проверяем API providers…" };
  }
  return { availability: "unavailable", reason: "Подходящий API не найден" };
}

function availabilityIcon(status) {
  if (status === "available") return "🟢";
  if (status === "requires_key") return "🟡";
  return "⚪";
}

function statusLabel(status) {
  const labels = {
    ready: "Готов",
    queued: "В очереди",
    uploading: "Uploading…",
    converting: "Converting…",
    downloading: "Downloading…",
    done: "✓ Готово",
    error: "Ошибка"
  };
  return labels[status] || "Готов";
}

function selectedPairStatus(item) {
  const key = `${item.source}->${item.target}`;
  return state.pairStatus.get(key) || (item.target ? availabilityFor(item.source, item.target) : null);
}

function renderTargetSelect(item) {
  const select = document.createElement("select");
  select.className = "target-select";
  select.dataset.id = item.id;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.loadingTargets.has(item.source) ? "Проверяем API…" : "Выберите формат";
  select.append(placeholder);

  const categories = state.globalCategory ? [state.globalCategory] : CATEGORIES.map(item => item.id);
  for (const categoryId of categories) {
    const group = document.createElement("optgroup");
    group.label = CATEGORIES.find(category => category.id === categoryId)?.label || categoryId;
    const formats = candidateFormatsForCategory(categoryId, item.source);
    for (const format of formats) {
      if (format.extension === item.source) continue;
      const availability = availabilityFor(item.source, format.extension);
      const option = document.createElement("option");
      option.value = format.extension;
      option.textContent = `${availabilityIcon(availability.availability)} ${format.extension.toUpperCase()} — ${format.name}`;
      option.title = availability.reason || "";
      option.disabled = ["unavailable", "online_disabled"].includes(availability.availability);
      if (item.target === format.extension) option.selected = true;
      group.append(option);
    }
    if (group.children.length) select.append(group);
  }

  if (item.target && ![...select.options].some(option => option.value === item.target)) {
    const current = getFormat(item.target);
    const option = document.createElement("option");
    option.value = current.extension;
    option.textContent = `${current.extension.toUpperCase()} — ${current.name}`;
    option.selected = true;
    select.append(option);
  }

  select.disabled = ["queued", "uploading", "converting", "downloading", "done"].includes(item.status);
  select.addEventListener("change", async () => {
    const target = select.value;
    await send("UPDATE_ITEM", { id: item.id, patch: { target, status: "ready", progress: 0, detail: target ? "Проверяем выбранную пару" : "Выберите формат", error: "", remote: null } });
    if (target) await refreshPairStatus(item.source, target, true);
  });
  return select;
}

function renderQueue() {
  els.fileList.innerHTML = "";
  const count = state.queue.length;
  els.queueSummary.textContent = `${count} ${count === 1 ? "файл" : count > 1 && count < 5 ? "файла" : "файлов"}`;
  els.emptyState.hidden = count > 0;
  els.batchControls.hidden = count === 0;
  els.clearBtn.hidden = count === 0;

  for (const item of state.queue) {
    const card = document.createElement("article");
    card.className = "file-card";

    const top = document.createElement("div");
    top.className = "file-top";
    const nameWrap = document.createElement("div");
    nameWrap.innerHTML = `<div class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div><div class="file-meta"><span>${formatBytes(item.size)}</span><span>${escapeHtml(getFormat(item.source).categoryLabel)}</span><span>${escapeHtml(item.source.toUpperCase() || "UNKNOWN")}</span></div>`;
    const remove = document.createElement("button");
    remove.className = "remove-file";
    remove.type = "button";
    remove.title = "Удалить из очереди";
    remove.textContent = "×";
    remove.disabled = ["queued", "uploading", "converting", "downloading"].includes(item.status);
    remove.addEventListener("click", () => send("REMOVE_ITEM", { id: item.id }).catch(error => showToast(error.message)));
    top.append(nameWrap, remove);

    const conversion = document.createElement("div");
    conversion.className = "file-conversion";
    const from = document.createElement("div");
    from.className = "format-box";
    from.innerHTML = `<label>From</label><div class="from-chip">${escapeHtml(item.source.toUpperCase() || "?")}</div>`;
    const arrow = document.createElement("div");
    arrow.className = "arrow";
    arrow.textContent = "→";
    const to = document.createElement("div");
    to.className = "format-box";
    const toLabel = document.createElement("label");
    toLabel.textContent = "To";
    to.append(toLabel, renderTargetSelect(item));
    conversion.append(from, arrow, to);

    const status = document.createElement("div");
    status.className = "status-row";
    const badge = document.createElement("span");
    const pair = selectedPairStatus(item);
    const badgeClass = item.status === "error" ? "error" : item.status === "done" ? "available" : pair?.availability || "";
    badge.className = `status-badge ${badgeClass}`;
    badge.textContent = ["uploading", "converting", "downloading", "queued", "done", "error"].includes(item.status)
      ? statusLabel(item.status)
      : item.target && pair
        ? `${availabilityIcon(pair.availability)} ${pair.availability === "available" ? "Доступно" : pair.availability === "requires_key" ? "Нужен API key" : pair.availability === "loading" ? "Проверка" : "Недоступно"}`
        : "Выберите формат";
    badge.title = pair?.reason || item.detail || "";
    const detail = document.createElement("span");
    detail.className = "file-detail";
    detail.textContent = item.detail || pair?.reason || "";
    detail.title = detail.textContent;
    status.append(badge, detail);

    const progressTrack = document.createElement("div");
    progressTrack.className = "progress-track";
    const progress = document.createElement("div");
    progress.className = "progress-bar";
    progress.style.width = `${Math.max(0, Math.min(100, Number(item.progress || 0)))}%`;
    progressTrack.append(progress);

    card.append(top, conversion, status, progressTrack);
    if (item.error) {
      const error = document.createElement("div");
      error.className = "file-error";
      error.textContent = item.error;
      card.append(error);
    }
    els.fileList.append(card);
  }

  renderGlobalTarget();
  renderFooterState();
}

function renderGlobalTarget() {
  const previous = els.globalTarget.value;
  els.globalTarget.innerHTML = '<option value="">Выберите формат</option>';
  if (!state.queue.length) return;

  const formats = new Map();
  for (const item of state.queue) {
    for (const format of candidateFormatsForCategory(state.globalCategory, item.source)) {
      if (format.extension !== item.source) formats.set(format.extension, format);
    }
  }

  for (const format of [...formats.values()].sort((a, b) => a.extension.localeCompare(b.extension))) {
    const statuses = state.queue.map(item => availabilityFor(item.source, format.extension));
    let availability = "available";
    if (statuses.some(status => status.availability === "online_disabled")) availability = "online_disabled";
    else if (statuses.some(status => ["unavailable", "loading"].includes(status.availability))) availability = "unavailable";
    else if (statuses.some(status => status.availability === "requires_key")) availability = "requires_key";

    const option = document.createElement("option");
    option.value = format.extension;
    option.textContent = `${availabilityIcon(availability)} ${format.extension.toUpperCase()} — ${format.name}`;
    option.disabled = ["unavailable", "online_disabled"].includes(availability);
    els.globalTarget.append(option);
  }
  if ([...els.globalTarget.options].some(option => option.value === previous && !option.disabled)) els.globalTarget.value = previous;
}

function renderFooterState() {
  const configured = state.providers.filter(provider => provider.enabled && provider.configured);
  if (!state.settings.onlineEnabled) {
    els.providerHint.textContent = "Онлайн-конвертация выключена. API-форматы недоступны.";
  } else if (!configured.length) {
    els.providerHint.textContent = "Нужен API key хотя бы одного provider. Settings → API Providers.";
  } else {
    const healthy = configured.filter(provider => !provider.coolingDown);
    const cooling = configured.filter(provider => provider.coolingDown);
    const healthyText = healthy.length ? healthy.map(provider => provider.name).join(", ") : "нет активных";
    const coolingText = cooling.length ? ` Временно пропускаются: ${cooling.map(provider => provider.name).join(", ")}.` : "";
    els.providerHint.textContent = `Готовы: ${healthyText}. Автопереключение API включено.${coolingText} Результаты скачиваются автоматически.`;
  }
  const convertible = state.queue.filter(item => item.target && !["queued", "uploading", "converting", "downloading", "done"].includes(item.status));
  els.convertAllBtn.disabled = !state.settings.onlineEnabled || !convertible.length;
}

function renderPrivacy() {
  const enabled = state.settings.onlineEnabled;
  els.privacyBanner.classList.toggle("off", !enabled);
  els.privacyBanner.querySelector("strong").textContent = enabled ? "Онлайн-конвертация включена" : "Онлайн-конвертация отключена";
  els.privacyBanner.querySelector("span:not(.privacy-dot)").textContent = enabled
    ? "Файл отправляется выбранному стороннему API-сервису; при ошибке может использоваться следующий включённый provider."
    : "Файлы не будут отправляться API. Онлайн-форматы недоступны.";
  els.onlineToggle.checked = enabled;
  els.onlineStatusCopy.textContent = enabled
    ? "ON — исходный файл передаётся выбранному provider. Если он завершится ошибкой, ProviderManager может отправить файл следующему включённому совместимому provider. Собственного backend у расширения нет."
    : "OFF — расширение не будет отправлять выбранные файлы provider API. Форматы, требующие онлайн-конвертации, будут серыми.";
}

function renderProviders() {
  els.providerList.innerHTML = "";
  for (const provider of state.providers) {
    const config = state.settings.providers[provider.id] || { enabled: true, apiKey: "" };
    const card = document.createElement("div");
    card.className = "provider-card";
    const status = provider.status;
    const health = provider.health;
    const coolingDown = Boolean(provider.coolingDown);
    const dotClass = coolingDown ? "warn" : status?.ok ? "ok" : status?.kind === "missing_key" || !provider.configured ? "warn" : status ? "bad" : "";
    const healthCopy = coolingDown
      ? `Авто-fallback временно пропускает provider до ${new Date(Number(health.cooldownUntil || 0)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${health.lastMessage || health.kind || "API error"}`
      : "";
    card.innerHTML = `
      <div class="provider-head">
        <div class="provider-title"><span class="provider-state-dot ${dotClass}"></span>${escapeHtml(provider.name)}</div>
        <label class="provider-enabled"><input type="checkbox" class="provider-enabled-input" data-provider="${provider.id}" ${config.enabled !== false ? "checked" : ""}> включён</label>
      </div>
      <div class="provider-free">${escapeHtml(provider.freeTier)}<br>${escapeHtml(provider.retention)}</div>
      <div class="provider-controls">
        <div class="api-key-wrap">
          <input type="password" class="provider-key" data-provider="${provider.id}" autocomplete="off" placeholder="API key / token" value="${escapeAttr(config.apiKey || "")}">
          <button type="button" class="toggle-key" data-provider="${provider.id}">Показать</button>
        </div>
        <button type="button" class="secondary small check-provider" data-provider="${provider.id}">Проверить</button>
      </div>
      <div class="provider-status">${escapeHtml(healthCopy || status?.message || (provider.configured ? "Ключ настроен; проверка ещё не запускалась." : "API key не задан."))}</div>
    `;
    els.providerList.append(card);
  }

  els.providerList.querySelectorAll(".toggle-key").forEach(button => {
    button.addEventListener("click", () => {
      const input = els.providerList.querySelector(`.provider-key[data-provider="${button.dataset.provider}"]`);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      button.textContent = input.type === "password" ? "Показать" : "Скрыть";
    });
  });

  els.providerList.querySelectorAll(".provider-key").forEach(input => {
    input.addEventListener("change", async () => {
      await persistProviderControls();
      await checkProvider(input.dataset.provider, true);
    });
  });

  els.providerList.querySelectorAll(".provider-enabled-input").forEach(input => {
    input.addEventListener("change", async () => {
      await persistProviderControls();
      await reloadCapabilities();
    });
  });

  els.providerList.querySelectorAll(".check-provider").forEach(button => {
    button.addEventListener("click", async () => {
      await persistProviderControls();
      await checkProvider(button.dataset.provider, true);
    });
  });
}

async function persistProviderControls() {
  const providers = { ...state.settings.providers };
  els.providerList.querySelectorAll(".provider-key").forEach(input => {
    const id = input.dataset.provider;
    providers[id] = { ...(providers[id] || {}), apiKey: input.value.trim() };
  });
  els.providerList.querySelectorAll(".provider-enabled-input").forEach(input => {
    const id = input.dataset.provider;
    providers[id] = { ...(providers[id] || {}), enabled: input.checked };
  });
  state.settings = mergeSettings({ ...state.settings, providers });
  state.settings = await send("SAVE_SETTINGS", { settings: state.settings });
  const fresh = await send("GET_STATE");
  state.providers = fresh.providers;
}

async function checkProvider(providerId, notify = false) {
  try {
    const result = await send("CHECK_PROVIDER", { providerId });
    const fresh = await send("GET_STATE");
    state.providers = fresh.providers;
    renderProviders();
    if (notify) showToast(result.message || "Provider проверен");
    await reloadCapabilities(false);
  } catch (error) {
    if (notify) showToast(error.message);
  }
}

async function ensureTargets(source, force = false) {
  const input = normalizeFormat(source);
  if (!input) return;
  if (!force && state.targets.has(input)) return;
  if (state.loadingTargets.has(input)) return;
  state.loadingTargets.add(input);
  renderQueue();
  try {
    const result = await send("GET_TARGETS", { source: input, force });
    state.targets.set(input, result);
  } catch (error) {
    state.targets.set(input, { source: input, targets: [], providers: [], onlineEnabled: state.settings.onlineEnabled, error: error.message });
  } finally {
    state.loadingTargets.delete(input);
    renderQueue();
  }
}

async function refreshPairStatus(source, target, force = false) {
  const key = `${source}->${target}`;
  try {
    const result = await send("GET_PAIR_STATUS", { source, target, force });
    state.pairStatus.set(key, result);
  } catch (error) {
    state.pairStatus.set(key, { availability: "unavailable", reason: error.message, providers: [] });
  }
  renderQueue();
}

async function reloadCapabilities(clearRemote = true) {
  if (clearRemote) await send("REFRESH_CAPABILITIES");
  state.targets.clear();
  state.pairStatus.clear();
  const sources = [...new Set(state.queue.map(item => item.source).filter(Boolean))];
  await Promise.all(sources.map(source => ensureTargets(source, true)));
  renderQueue();
}

async function handleFiles(fileList) {
  const files = [...(fileList || [])].filter(file => file instanceof File);
  if (!files.length) return;
  const items = [];
  for (const file of files) {
    const source = formatSourceFromFile(file);
    const id = crypto.randomUUID();
    try {
      await putFile(id, file);
      items.push({ id, name: file.name, size: file.size, mimeType: file.type, source });
    } catch (error) {
      showToast(`Не удалось сохранить ${file.name}: ${error.message}`);
    }
  }
  if (!items.length) return;
  state.queue = await send("ADD_ITEMS", { items });
  if (state.queue.length === items.length && items[0]?.source) {
    const sourceCategory = getCategoryForFormat(items[0].source);
    if (sourceCategory && sourceCategory !== "other") {
      state.globalCategory = sourceCategory === "raw" ? "images" : sourceCategory;
      els.globalCategory.value = state.globalCategory;
    }
  }
  await Promise.all([...new Set(items.map(item => item.source))].map(source => ensureTargets(source)));
  renderQueue();
}

async function applyGlobalTarget(target) {
  if (!target) return;
  let changed = 0;
  let skipped = 0;
  for (const item of state.queue) {
    const availability = availabilityFor(item.source, target);
    if (!["available", "requires_key"].includes(availability.availability)) {
      skipped += 1;
      continue;
    }
    await send("UPDATE_ITEM", { id: item.id, patch: { target, status: "ready", progress: 0, detail: "Формат выбран", error: "", remote: null } });
    changed += 1;
    refreshPairStatus(item.source, target).catch(() => undefined);
  }
  if (skipped) showToast(`Формат применён: ${changed}; несовместимых файлов: ${skipped}`);
}

async function persistAppearance() {
  state.settings = mergeSettings({
    ...state.settings,
    appearance: {
      theme: els.themeSelect.value,
      accentColor: els.accentColor.value,
      buttonColor: els.buttonColor.value,
      backgroundColor: els.backgroundColor.value,
      radius: Number(els.radiusRange.value)
    }
  });
  applyAppearance();
  state.settings = await send("SAVE_SETTINGS", { settings: state.settings });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab === button));
      document.querySelectorAll(".view").forEach(view => view.classList.remove("active"));
      document.getElementById(`view-${button.dataset.tab}`).classList.add("active");
    });
  });

  els.pickFilesBtn.addEventListener("click", event => {
    event.stopPropagation();
    els.fileInput.click();
  });
  els.dropZone.addEventListener("click", event => {
    if (event.target !== els.pickFilesBtn) els.fileInput.click();
  });
  els.dropZone.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", async () => {
    await handleFiles(els.fileInput.files);
    els.fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach(type => els.dropZone.addEventListener(type, event => {
    event.preventDefault();
    els.dropZone.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach(type => els.dropZone.addEventListener(type, event => {
    event.preventDefault();
    els.dropZone.classList.remove("dragover");
  }));
  els.dropZone.addEventListener("drop", event => handleFiles(event.dataTransfer?.files));

  els.clearBtn.addEventListener("click", async () => {
    state.queue = await send("CLEAR_QUEUE");
    state.pairStatus.clear();
    renderQueue();
  });

  els.globalCategory.addEventListener("change", () => {
    state.globalCategory = els.globalCategory.value;
    renderQueue();
  });
  els.globalTarget.addEventListener("change", () => applyGlobalTarget(els.globalTarget.value).catch(error => showToast(error.message)));

  els.convertAllBtn.addEventListener("click", async () => {
    const ids = state.queue
      .filter(item => item.target && !["queued", "uploading", "converting", "downloading", "done"].includes(item.status))
      .map(item => item.id);
    if (!ids.length) return;
    await send("START_CONVERSIONS", { ids });
    showToast(`Запущено заданий: ${ids.length}`);
  });

  [els.themeSelect, els.accentColor, els.buttonColor, els.backgroundColor].forEach(input => {
    input.addEventListener("change", () => persistAppearance().catch(error => showToast(error.message)));
  });
  els.radiusRange.addEventListener("input", () => {
    els.radiusValue.textContent = `${els.radiusRange.value}px`;
    document.documentElement.style.setProperty("--radius", `${els.radiusRange.value}px`);
  });
  els.radiusRange.addEventListener("change", () => persistAppearance().catch(error => showToast(error.message)));

  els.resetAppearanceBtn.addEventListener("click", async () => {
    state.settings = await send("RESET_APPEARANCE");
    applyAppearance();
    showToast("Оформление сброшено");
  });

  els.onlineToggle.addEventListener("change", async () => {
    state.settings.onlineEnabled = els.onlineToggle.checked;
    state.settings = await send("SAVE_SETTINGS", { settings: state.settings });
    renderPrivacy();
    state.pairStatus.clear();
    renderQueue();
  });

  els.refreshCapabilitiesBtn.addEventListener("click", async () => {
    els.refreshCapabilitiesBtn.disabled = true;
    try {
      await reloadCapabilities(true);
      showToast("Список форматов обновлён через provider APIs");
    } catch (error) {
      showToast(error.message);
    } finally {
      els.refreshCapabilitiesBtn.disabled = false;
    }
  });
}

async function init() {
  setupCategorySelect();
  bindEvents();
  const initial = await send("GET_STATE");
  state.settings = mergeSettings(initial.settings);
  state.queue = initial.queue || [];
  state.providers = initial.providers || [];
  applyAppearance();
  renderPrivacy();
  renderProviders();
  renderQueue();
  await Promise.all([...new Set(state.queue.map(item => item.source).filter(Boolean))].map(source => ensureTargets(source)));
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.ufcQueue) {
    state.queue = Array.isArray(changes.ufcQueue.newValue) ? changes.ufcQueue.newValue : [];
    for (const source of new Set(state.queue.map(item => item.source).filter(Boolean))) ensureTargets(source).catch(() => undefined);
    renderQueue();
  }
  if (changes.ufcSettings?.newValue) {
    state.settings = mergeSettings(changes.ufcSettings.newValue);
    applyAppearance();
    renderPrivacy();
    renderQueue();
  }
  if (changes.ufcProviderStatus) {
    send("GET_STATE").then(fresh => {
      state.providers = fresh.providers || [];
      renderProviders();
    }).catch(() => undefined);
  }
});

init().catch(error => {
  console.error(error);
  showToast(error.message || String(error));
});
