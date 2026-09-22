export function normalizeFormat(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "")
    .replace(/[^a-z0-9+_-]/g, "");
}

export function extensionOf(name) {
  const clean = String(name || "").split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() || "";
  const index = base.lastIndexOf(".");
  return index > 0 && index < base.length - 1 ? normalizeFormat(base.slice(index + 1)) : "";
}

export function baseName(name) {
  const base = String(name || "file").split(/[\\/]/).pop() || "file";
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(0, index) : base;
}

export function outputName(inputName, target) {
  return `${baseName(inputName)}.${normalizeFormat(target) || "converted"}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / Math.pow(1024, index);
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchJson(url, options = {}, label = "API") {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const wrapped = new Error(`${label}: network error: ${error?.message || error}`);
    wrapped.code = "NETWORK";
    throw wrapped;
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message = extractApiMessage(body) || response.statusText || `HTTP ${response.status}`;
    const error = new Error(`${label}: ${message}`);
    error.status = response.status;
    error.body = body;
    if (response.status === 401) error.code = "AUTH";
    else if (response.status === 402 || response.status === 403) error.code = "QUOTA_OR_PERMISSION";
    else if (response.status === 408 || response.status === 429 || response.status >= 500) error.code = "TEMPORARY";
    else error.code = "API";
    throw error;
  }

  return body;
}

export function extractApiMessage(body) {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 500);
  const direct = [body.message, body.error, body.error_message, body.errorMessage, body.detail, body.description]
    .find(value => typeof value === "string" && value.trim());
  if (direct) return direct;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map(item => typeof item === "string" ? item : item?.message || JSON.stringify(item)).join("; ").slice(0, 500);
  }
  if (body.data && typeof body.data === "object") return extractApiMessage(body.data);
  return "";
}

export function dataRoot(body) {
  if (body && typeof body === "object" && body.data !== undefined) return body.data;
  return body;
}

export function getId(value) {
  if (!value || typeof value !== "object") return "";
  return String(value.id || value._id || value.uuid || value.jobId || "");
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

export function findTask(container, operation) {
  const root = dataRoot(container) || container;
  const tasks = asArray(root?.tasks);
  return tasks.find(task => String(task?.operation || "").toLowerCase() === operation.toLowerCase()) || null;
}

export function getTaskStatus(task) {
  return String(task?.status || "").toLowerCase();
}

export function extractUploadForm(container) {
  const task = findTask(container, "import/upload") || container;
  const form = task?.result?.form || task?.form || task?.result?.data?.form;
  if (!form?.url) return null;
  return {
    url: String(form.url),
    parameters: form.parameters && typeof form.parameters === "object" ? form.parameters : {}
  };
}

export function extractDownloadFiles(container) {
  const root = dataRoot(container) || container;
  const candidates = [];

  const pushFile = value => {
    if (!value) return;
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      candidates.push({ url: value, filename: "" });
      return;
    }
    if (typeof value !== "object") return;
    const url = value.url || value.Url || value.fileUrl || value.FileUrl || value.download_url || value.downloadUrl;
    if (url && /^https?:\/\//i.test(String(url))) {
      candidates.push({
        url: String(url),
        filename: String(value.filename || value.fileName || value.FileName || value.name || value.Name || "")
      });
    }
  };

  const exportTask = findTask(root, "export/url");
  const result = exportTask?.result || root?.result || root;
  for (const value of asArray(result?.files)) pushFile(value);
  for (const value of asArray(result?.Files)) pushFile(value);
  for (const value of asArray(result?.urls)) pushFile(value);
  for (const value of asArray(result?.Urls)) pushFile(value);
  pushFile(result);

  if (Array.isArray(root?.Files)) root.Files.forEach(pushFile);
  if (Array.isArray(root?.files)) root.files.forEach(pushFile);

  const seen = new Set();
  return candidates.filter(file => {
    if (!file.url || seen.has(file.url)) return false;
    seen.add(file.url);
    return true;
  });
}

export async function postMultipartForm(form, file, fileName, extraHeaders = {}) {
  if (!form?.url) throw new Error("Upload form URL is missing");
  const formData = new FormData();
  for (const [key, value] of Object.entries(form.parameters || {})) {
    formData.append(key, String(value));
  }
  formData.append("file", file, fileName || file.name || "input.bin");
  const response = await fetch(form.url, {
    method: "POST",
    headers: extraHeaders,
    body: formData,
    redirect: "follow"
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`Upload failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 300)}` : ""}`);
    error.status = response.status;
    error.code = response.status >= 500 || response.status === 429 ? "TEMPORARY" : "UPLOAD";
    throw error;
  }
  return response;
}

export function uniqueFormats(values) {
  const set = new Set();
  for (const value of values || []) {
    const format = normalizeFormat(value);
    if (format) set.add(format);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function statusErrorSummary(error) {
  if (!error) return "Unknown error";
  return String(error.message || error).replace(/\s+/g, " ").trim().slice(0, 700);
}
