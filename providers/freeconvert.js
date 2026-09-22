import {
  asArray,
  dataRoot,
  extractApiMessage,
  extractDownloadFiles,
  extractUploadForm,
  fetchJson,
  findTask,
  getId,
  getTaskStatus,
  normalizeFormat,
  postMultipartForm,
  sleep,
  uniqueFormats
} from "../core/utils.js";

const API = "https://api.freeconvert.com/v1";

function headers(apiKey, json = false) {
  const result = { Accept: "application/json" };
  if (apiKey) result.Authorization = `Bearer ${apiKey}`;
  if (json) result["Content-Type"] = "application/json";
  return result;
}

function parseFormatList(body) {
  const root = dataRoot(body) || body;
  const rows = Array.isArray(root?.formats) ? root.formats : Array.isArray(root) ? root : [];
  return uniqueFormats(rows.map(item => typeof item === "string" ? item : item?.ext || item?.extension || item?.format || item?.id));
}

async function getJob(jobId, apiKey) {
  return fetchJson(`${API}/process/jobs/${encodeURIComponent(jobId)}`, {
    headers: headers(apiKey)
  }, "FreeConvert");
}

function jobState(jobResponse) {
  const root = dataRoot(jobResponse) || jobResponse;
  const status = String(root?.status || "").toLowerCase();
  const tasks = asArray(root?.tasks);
  const failed = tasks.find(task => ["failed", "error", "canceled"].includes(String(task?.status || "").toLowerCase()));
  return { root, status, failed };
}

async function waitForJob(jobId, apiKey, onState) {
  const started = Date.now();
  const timeout = 6 * 60 * 60 * 1000;
  while (Date.now() - started < timeout) {
    const response = await getJob(jobId, apiKey);
    const { root, status, failed } = jobState(response);
    const exportTask = findTask(root, "export/url");
    if (["completed", "finished"].includes(status) || ["completed", "finished"].includes(getTaskStatus(exportTask))) return response;
    if (failed || ["failed", "error", "canceled"].includes(status)) {
      const error = new Error(failed?.message || extractApiMessage(response) || "FreeConvert job failed");
      error.code = "API";
      throw error;
    }
    await onState?.({ stage: "converting", progress: 60, detail: status || "processing" });
    await sleep(2200);
  }
  const error = new Error("FreeConvert job timed out while waiting for completion");
  error.code = "TEMPORARY";
  throw error;
}

async function ensureUploadForm(jobResponse, jobId, apiKey) {
  let form = extractUploadForm(jobResponse);
  if (form) return form;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(500);
    const refreshed = await getJob(jobId, apiKey);
    form = extractUploadForm(refreshed);
    if (form) return form;
  }
  return null;
}

async function uploadIfNeeded(jobResponse, jobId, file, apiKey) {
  let root = dataRoot(jobResponse) || jobResponse;
  let importTask = findTask(root, "import/upload");
  if (["completed", "finished"].includes(getTaskStatus(importTask))) return;
  const form = await ensureUploadForm(jobResponse, jobId, apiKey);
  if (!form) throw new Error("FreeConvert did not return an upload form");
  try {
    await postMultipartForm(form, file, file.name);
  } catch (error) {
    if (![401, 403].includes(error.status)) throw error;
    await postMultipartForm(form, file, file.name, { Authorization: `Bearer ${apiKey}` });
  }
}

export const FreeConvertProvider = {
  id: "freeconvert",
  name: "FreeConvert",
  priority: 30,
  requiresApiKey: true,
  freeTier: "Free API accounts receive 20 conversion minutes/day; free usage is limited to 5 conversion minutes per file.",
  retention: "Task files are automatically deleted 4 hours after task creation; job entries are deleted after 24 hours.",
  homepage: "https://www.freeconvert.com/",

  async getTargets(source) {
    const input = normalizeFormat(source);
    if (!input) return [];
    const response = await fetchJson(`${API}/query/formats/convert?input_format=${encodeURIComponent(input)}`, {
      headers: { Accept: "application/json" }
    }, "FreeConvert capabilities");
    return parseFormatList(response);
  },

  async supportsPair(source, target) {
    const output = normalizeFormat(target);
    if (!output) return false;
    const targets = await this.getTargets(source);
    return targets.includes(output);
  },

  async check(config) {
    try {
      await fetchJson(`${API}/query/formats`, { headers: { Accept: "application/json" } }, "FreeConvert capabilities");
    } catch (error) {
      return { ok: false, kind: "unavailable", message: error.message };
    }
    const apiKey = String(config?.apiKey || "").trim();
    if (!apiKey) return { ok: false, kind: "missing_key", message: "API доступен; API key не задан." };
    try {
      await fetchJson(`${API}/process/jobs`, { headers: headers(apiKey) }, "FreeConvert");
      return { ok: true, kind: "verified", message: "API key проверен. Доступ к заданиям FreeConvert работает." };
    } catch (error) {
      return { ok: false, kind: error.code === "AUTH" ? "invalid_key" : "error", message: error.message };
    }
  },

  async convert({ file, source, target, apiKey, onState, remote }) {
    const input = normalizeFormat(source);
    const output = normalizeFormat(target);
    if (!apiKey) {
      const error = new Error("FreeConvert API key is missing");
      error.code = "AUTH";
      throw error;
    }

    let jobResponse;
    let jobId = remote?.jobId || "";
    if (jobId) {
      jobResponse = await getJob(jobId, apiKey);
    } else {
      await onState?.({ stage: "uploading", progress: 8, detail: "Creating FreeConvert job" });
      jobResponse = await fetchJson(`${API}/process/jobs`, {
        method: "POST",
        headers: headers(apiKey, true),
        body: JSON.stringify({
          tasks: {
            "import-file": { operation: "import/upload" },
            "convert-file": {
              operation: "convert",
              input: "import-file",
              input_format: input,
              output_format: output
            },
            "export-file": {
              operation: "export/url",
              input: ["convert-file"]
            }
          }
        })
      }, "FreeConvert");
      jobId = getId(dataRoot(jobResponse));
      if (!jobId) throw new Error("FreeConvert did not return a job ID");
      await onState?.({
        stage: "uploading",
        progress: 12,
        detail: "Uploading to FreeConvert",
        remote: { provider: this.id, jobId }
      });
    }

    const root = dataRoot(jobResponse) || jobResponse;
    const exportTask = findTask(root, "export/url");
    if (!["completed", "finished"].includes(getTaskStatus(exportTask))) {
      await uploadIfNeeded(jobResponse, jobId, file, apiKey);
      await onState?.({
        stage: "converting",
        progress: 45,
        detail: "FreeConvert is converting",
        remote: { provider: this.id, jobId }
      });
      jobResponse = await waitForJob(jobId, apiKey, onState);
    }

    const files = extractDownloadFiles(jobResponse);
    if (!files.length) {
      const message = extractApiMessage(jobResponse) || "FreeConvert finished without a download URL";
      throw new Error(message);
    }
    return { files, remote: { provider: this.id, jobId } };
  }
};
