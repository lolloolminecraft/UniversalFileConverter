import {
  dataRoot,
  extractDownloadFiles,
  fetchJson,
  normalizeFormat,
  uniqueFormats
} from "../core/utils.js";

const API = "https://v2.convertapi.com";

function collectTargets(value, found = new Set(), depth = 0) {
  if (depth > 8 || value == null) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectTargets(item, found, depth + 1);
    return found;
  }
  if (typeof value !== "object") return found;

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
    const isTargetKey = /^(to|target|destination|output)(format|formats|fileformat|fileformats|extension|extensions|ext|exts)?$/.test(normalizedKey)
      || /^(output|target|destination)file(ext|extension)$/.test(normalizedKey);
    if (isTargetKey) {
      if (typeof item === "string") found.add(normalizeFormat(item));
      else if (Array.isArray(item)) {
        item.forEach(entry => {
          if (typeof entry === "string") found.add(normalizeFormat(entry));
          else if (entry && typeof entry === "object") {
            const raw = entry.ext || entry.extension || entry.format || entry.name || entry.id;
            if (typeof raw === "string") found.add(normalizeFormat(raw));
          }
        });
      }
    }
    if (typeof item === "string") {
      const match = item.match(/\/to\/([a-z0-9+_-]{1,16})(?:\b|\/|$)/i);
      if (match) found.add(normalizeFormat(match[1]));
    }
    collectTargets(item, found, depth + 1);
  }
  return found;
}

function parseCanConvert(body) {
  if (typeof body === "boolean") return body;
  if (typeof body === "string") return body.trim().toLowerCase() === "true";
  if (!body || typeof body !== "object") return false;
  for (const key of ["canConvert", "CanConvert", "canconvert", "supported", "Supported", "result", "Result"]) {
    if (key in body) {
      const value = body[key];
      if (typeof value === "boolean") return value;
      if (typeof value === "string") return value.toLowerCase() === "true";
      if (typeof value === "object") return parseCanConvert(value);
    }
  }
  const root = dataRoot(body);
  if (root !== body) return parseCanConvert(root);
  return false;
}

export const ConvertApiProvider = {
  id: "convertapi",
  name: "ConvertAPI",
  priority: 10,
  requiresApiKey: true,
  freeTier: "New accounts currently include a card-free trial with 250 conversions.",
  retention: "With StoreFile=true, converted-file URLs are documented as available for up to 3 hours.",
  homepage: "https://www.convertapi.com/",

  async getTargets(source) {
    const input = normalizeFormat(source);
    if (!input) return [];
    const response = await fetchJson(`${API}/info/openapi/${encodeURIComponent(input)}/to/*`, {
      headers: { Accept: "application/json" }
    }, "ConvertAPI capabilities");
    const paths = response?.paths && typeof response.paths === "object" ? Object.keys(response.paths) : [];
    const fromPaths = paths.map(path => {
      const match = String(path).match(/\/convert\/[^/]+\/to\/([^/?]+)/i);
      return match ? normalizeFormat(match[1]) : "";
    }).filter(Boolean);
    if (fromPaths.length) return uniqueFormats(fromPaths);
    return uniqueFormats([...collectTargets(response)].filter(Boolean));
  },

  async supportsPair(source, target) {
    const input = normalizeFormat(source);
    const output = normalizeFormat(target);
    if (!input || !output || input === output) return false;
    const response = await fetchJson(`${API}/info/canconvert/${encodeURIComponent(input)}/to/${encodeURIComponent(output)}`, {
      headers: { Accept: "application/json" }
    }, "ConvertAPI capabilities");
    return parseCanConvert(response);
  },

  async check(config) {
    try {
      await fetchJson(`${API}/info/canconvert/docx/to/pdf`, {
        headers: { Accept: "application/json" }
      }, "ConvertAPI capabilities");
    } catch (error) {
      return { ok: false, kind: "unavailable", message: error.message };
    }
    const apiKey = String(config?.apiKey || "").trim();
    if (!apiKey) return { ok: false, kind: "missing_key", message: "API доступен; API token не задан." };
    return {
      ok: true,
      kind: "reachable",
      message: "Capability API доступен. Token сохранён локально и будет проверен conversion endpoint при конвертации."
    };
  },

  async convert({ file, source, target, apiKey, onState, remote }) {
    const input = normalizeFormat(source);
    const output = normalizeFormat(target);
    if (!apiKey) {
      const error = new Error("ConvertAPI token is missing");
      error.code = "AUTH";
      throw error;
    }

    let jobId = remote?.jobId || "";
    if (!jobId) {
      await onState?.({ stage: "uploading", progress: 12, detail: "Uploading to ConvertAPI" });
      const form = new FormData();
      form.append("File", file, file.name);
      form.append("StoreFile", "true");

      let response;
      try {
        response = await fetch(`${API}/async/convert/${encodeURIComponent(input)}/to/${encodeURIComponent(output)}`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: form
        });
      } catch (error) {
        const wrapped = new Error(`ConvertAPI: network error: ${error?.message || error}`);
        wrapped.code = "NETWORK";
        throw wrapped;
      }

      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!response.ok) {
        const message = typeof body === "string" ? body : body?.Message || body?.message || body?.Error || response.statusText;
        const error = new Error(`ConvertAPI: ${String(message || `HTTP ${response.status}`).slice(0, 500)}`);
        error.status = response.status;
        if (response.status === 401) error.code = "AUTH";
        else if ([402, 403].includes(response.status)) error.code = "QUOTA_OR_PERMISSION";
        else if (response.status === 429 || response.status >= 500) error.code = "TEMPORARY";
        else error.code = "API";
        throw error;
      }
      jobId = String(body?.JobId || body?.jobId || body?.id || "");
      if (!jobId) throw new Error("ConvertAPI did not return an async JobId");
      await onState?.({
        stage: "converting",
        progress: 45,
        detail: "ConvertAPI job created",
        remote: { provider: this.id, jobId }
      });
    }

    const started = Date.now();
    const timeout = 6 * 60 * 60 * 1000;
    while (Date.now() - started < timeout) {
      let response;
      try {
        response = await fetch(`${API}/async/job/${encodeURIComponent(jobId)}`, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`
          }
        });
      } catch (error) {
        const wrapped = new Error(`ConvertAPI: network error while polling: ${error?.message || error}`);
        wrapped.code = "NETWORK";
        throw wrapped;
      }

      if (response.status === 202) {
        await onState?.({
          stage: "converting",
          progress: 62,
          detail: "ConvertAPI is converting",
          remote: { provider: this.id, jobId }
        });
        await new Promise(resolve => setTimeout(resolve, 2200));
        continue;
      }

      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (response.status === 200) {
        const files = extractDownloadFiles(body);
        if (!files.length) throw new Error("ConvertAPI finished without a downloadable URL. This pair may require non-standard parameters.");
        return { files, remote: { provider: this.id, jobId } };
      }

      const message = typeof body === "string" ? body : body?.Message || body?.message || response.statusText;
      const error = new Error(`ConvertAPI async job: ${String(message || `HTTP ${response.status}`).slice(0, 500)}`);
      error.status = response.status;
      if (response.status === 401) error.code = "AUTH";
      else if (response.status === 403) error.code = "QUOTA_OR_PERMISSION";
      else if (response.status === 404) error.code = "API";
      else error.code = "TEMPORARY";
      throw error;
    }

    const error = new Error("ConvertAPI job timed out while waiting for completion");
    error.code = "TEMPORARY";
    throw error;
  }
};
