import {
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

const API = "https://api.cloudconvert.com/v2";

function headers(apiKey, json = false) {
  const result = { Accept: "application/json" };
  if (apiKey) result.Authorization = `Bearer ${apiKey}`;
  if (json) result["Content-Type"] = "application/json";
  return result;
}

function jobError(job) {
  const root = dataRoot(job) || job;
  const failedTask = Array.isArray(root?.tasks)
    ? root.tasks.find(task => ["error", "failed"].includes(String(task?.status || "").toLowerCase()))
    : null;
  return failedTask?.message || failedTask?.code || root?.message || "CloudConvert job failed";
}

async function getJob(jobId, apiKey) {
  return fetchJson(`${API}/jobs/${encodeURIComponent(jobId)}`, {
    headers: headers(apiKey)
  }, "CloudConvert");
}

async function waitForJob(jobId, apiKey, onState) {
  const started = Date.now();
  const timeout = 6 * 60 * 60 * 1000;
  while (Date.now() - started < timeout) {
    const response = await getJob(jobId, apiKey);
    const job = dataRoot(response) || response;
    const status = String(job?.status || "").toLowerCase();
    const exportTask = findTask(job, "export/url");
    const convertTask = findTask(job, "convert");

    if (status === "finished" || getTaskStatus(exportTask) === "finished") return response;
    if (status === "error" || getTaskStatus(convertTask) === "error" || getTaskStatus(exportTask) === "error") {
      const error = new Error(jobError(response));
      error.code = "API";
      throw error;
    }

    await onState?.({ stage: "converting", progress: 58, detail: status || "processing" });
    await sleep(2200);
  }
  const error = new Error("CloudConvert job timed out while waiting for completion");
  error.code = "TEMPORARY";
  throw error;
}

async function uploadIfNeeded(jobResponse, file, apiKey) {
  const root = dataRoot(jobResponse) || jobResponse;
  const importTask = findTask(root, "import/upload");
  const status = getTaskStatus(importTask);
  if (["finished", "completed"].includes(status)) return;

  let form = extractUploadForm(root);
  if (!form && getId(root)) {
    const refreshed = await getJob(getId(root), apiKey);
    form = extractUploadForm(refreshed);
  }
  if (!form) throw new Error("CloudConvert did not return an upload form");
  await postMultipartForm(form, file, file.name);
}

export const CloudConvertProvider = {
  id: "cloudconvert",
  name: "CloudConvert",
  priority: 20,
  requiresApiKey: true,
  freeTier: "10 conversion credits/day; free plan max file size 1 GB and max processing time 5 minutes.",
  retention: "Export URLs/tasks are automatically removed after 24 hours.",
  homepage: "https://cloudconvert.com/",

  async getTargets(source) {
    const input = normalizeFormat(source);
    if (!input) return [];
    const params = new URLSearchParams({
      "filter[operation]": "convert",
      "filter[input_format]": input
    });
    const response = await fetchJson(`${API}/operations?${params.toString()}`, {
      headers: { Accept: "application/json" }
    }, "CloudConvert capabilities");
    const rows = Array.isArray(dataRoot(response)) ? dataRoot(response) : [];
    return uniqueFormats(rows
      .filter(row => String(row?.operation || "").toLowerCase() === "convert")
      .map(row => row?.output_format));
  },

  async supportsPair(source, target) {
    const input = normalizeFormat(source);
    const output = normalizeFormat(target);
    if (!input || !output || input === output) return false;
    const params = new URLSearchParams({
      "filter[operation]": "convert",
      "filter[input_format]": input,
      "filter[output_format]": output
    });
    const response = await fetchJson(`${API}/operations?${params.toString()}`, {
      headers: { Accept: "application/json" }
    }, "CloudConvert capabilities");
    const rows = Array.isArray(dataRoot(response)) ? dataRoot(response) : [];
    return rows.some(row => normalizeFormat(row?.input_format) === input && normalizeFormat(row?.output_format) === output);
  },

  async check(config) {
    try {
      await this.getTargets("pdf");
    } catch (error) {
      return { ok: false, kind: "unavailable", message: error.message };
    }
    const apiKey = String(config?.apiKey || "").trim();
    if (!apiKey) return { ok: false, kind: "missing_key", message: "API доступен; API key не задан." };
    try {
      await fetchJson(`${API}/jobs?per_page=1`, { headers: headers(apiKey) }, "CloudConvert");
      return { ok: true, kind: "verified", message: "API key проверен. Доступ к заданиям работает." };
    } catch (error) {
      return { ok: false, kind: error.code === "AUTH" ? "invalid_key" : "error", message: error.message };
    }
  },

  async convert({ file, source, target, apiKey, onState, remote }) {
    const input = normalizeFormat(source);
    const output = normalizeFormat(target);
    if (!apiKey) {
      const error = new Error("CloudConvert API key is missing");
      error.code = "AUTH";
      throw error;
    }

    let jobResponse;
    let jobId = remote?.jobId || "";
    if (jobId) {
      jobResponse = await getJob(jobId, apiKey);
    } else {
      await onState?.({ stage: "uploading", progress: 8, detail: "Creating CloudConvert job" });
      jobResponse = await fetchJson(`${API}/jobs`, {
        method: "POST",
        headers: headers(apiKey, true),
        body: JSON.stringify({
          tag: `ufc-${Date.now()}`,
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
              input: "convert-file",
              inline: false
            }
          }
        })
      }, "CloudConvert");
      jobId = getId(dataRoot(jobResponse));
      if (!jobId) throw new Error("CloudConvert did not return a job ID");
      await onState?.({
        stage: "uploading",
        progress: 12,
        detail: "Uploading to CloudConvert",
        remote: { provider: this.id, jobId }
      });
    }

    const current = dataRoot(jobResponse) || jobResponse;
    const exportTask = findTask(current, "export/url");
    if (!["finished", "completed"].includes(getTaskStatus(exportTask))) {
      await uploadIfNeeded(jobResponse, file, apiKey);
      await onState?.({
        stage: "converting",
        progress: 45,
        detail: "CloudConvert is converting",
        remote: { provider: this.id, jobId }
      });
      jobResponse = await waitForJob(jobId, apiKey, onState);
    }

    const files = extractDownloadFiles(jobResponse);
    if (!files.length) {
      const message = extractApiMessage(jobResponse) || "CloudConvert finished without a download URL";
      throw new Error(message);
    }
    return { files, remote: { provider: this.id, jobId } };
  }
};
