import {
  extractApiMessage,
  fetchJson,
  normalizeFormat,
  sleep,
  uniqueFormats
} from "../core/utils.js";

const API = "https://api.convert3d.org";

const INPUT_FORMATS = new Set(`
3d 3dm 3ds 3mf ac ac3d acc amf amj ase ask b3d blend brep bvh cob csm dae dwg dxf enff fbx gcode glb gltf hmb ifc iges igs iqm irr irrmesh lwo lws lxo m3d max md2 md3 md5 mdc mdl mot ms3d nc ndo nff obj off ogex ply pmx prj q3o q3s rbxl rbxm scn sib sldasm slddrw sldprt smd step stl stp ter uc usd usda usdc usdz vox vta x x3d xgl xml zgl
`.trim().split(/\s+/));

const OUTPUT_FORMATS = Object.freeze(`3dm 3ds 3mf dae dwg dxf fbx glb gltf obj ply rbxl rbxm stl stp usdz x`.split(" "));

function authHeaders(apiKey) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

function convert3dError(body, fallback = "Convert3D request failed") {
  return extractApiMessage(body) || body?.error || body?.message || fallback;
}

async function getJob(jobId, apiKey) {
  return fetchJson(`${API}/convert/jobs/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(apiKey)
  }, "Convert3D");
}

export const Convert3DProvider = {
  id: "convert3d",
  name: "Convert3D",
  priority: 5,
  requiresApiKey: true,
  freeTier: "Free API plan: 10 conversions/month.",
  retention: "API conversion is server-side; treat returned signed download URLs as temporary private links.",
  homepage: "https://convert3d.org/developer-api",

  async getTargets(source) {
    const input = normalizeFormat(source);
    if (!input || input === "raw" || !INPUT_FORMATS.has(input)) return [];
    return uniqueFormats(OUTPUT_FORMATS.filter(format => format !== input));
  },

  async supportsPair(source, target) {
    const input = normalizeFormat(source);
    const output = normalizeFormat(target);
    return Boolean(input && output && input !== output && input !== "raw" && INPUT_FORMATS.has(input) && OUTPUT_FORMATS.includes(output));
  },

  async check(config) {
    try {
      const health = await fetch(`${API}/health`, { headers: { Accept: "text/plain" } });
      if (!health.ok) return { ok: false, kind: "unavailable", message: `Convert3D health check: HTTP ${health.status}` };
    } catch (error) {
      return { ok: false, kind: "unavailable", message: `Convert3D: network error: ${error?.message || error}` };
    }

    const apiKey = String(config?.apiKey || "").trim();
    if (!apiKey) return { ok: false, kind: "missing_key", message: "API доступен; API token не задан." };

    try {
      const response = await fetch(`${API}/convert/jobs/job_ufc_key_check`, {
        headers: authHeaders(apiKey)
      });
      if (response.status === 401) return { ok: false, kind: "invalid_key", message: "Convert3D отклонил API token." };
      if ([403, 429].includes(response.status)) {
        const text = await response.text().catch(() => "");
        return { ok: false, kind: "quota_or_permission", message: text || `Convert3D: HTTP ${response.status}` };
      }
      if (response.status === 404 || response.ok) {
        return { ok: true, kind: "verified", message: "API token принят Convert3D." };
      }
      const text = await response.text().catch(() => "");
      return { ok: false, kind: "error", message: text || `Convert3D: HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, kind: "error", message: `Convert3D: ${error?.message || error}` };
    }
  },

  async convert({ file, source, target, apiKey, onState, remote }) {
    const input = normalizeFormat(source);
    const output = normalizeFormat(target);
    if (!apiKey) {
      const error = new Error("Convert3D API token is missing");
      error.code = "AUTH";
      throw error;
    }
    if (!(await this.supportsPair(input, output))) {
      const error = new Error(`Convert3D does not support ${input} → ${output}`);
      error.code = "API";
      throw error;
    }

    let jobId = String(remote?.jobId || "");
    if (!jobId) {
      await onState?.({ stage: "uploading", progress: 10, detail: "Uploading to Convert3D" });
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("from", input);
      form.append("to", output);

      const created = await fetchJson(`${API}/convert/jobs`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: form
      }, "Convert3D");
      jobId = String(created?.id || created?.jobId || "");
      if (!jobId) throw new Error("Convert3D did not return a job ID");
      await onState?.({
        stage: "converting",
        progress: Math.max(20, Number(created?.progress || 0)),
        detail: "Convert3D job created",
        remote: { provider: this.id, jobId }
      });
    }

    const started = Date.now();
    const timeout = 6 * 60 * 60 * 1000;
    while (Date.now() - started < timeout) {
      const job = await getJob(jobId, apiKey);
      const status = String(job?.status || "").toLowerCase();
      const progress = Math.max(20, Math.min(90, Number(job?.progress || 50)));

      if (status === "success") {
        const url = String(job?.signedUrl || job?.signed_url || job?.url || "");
        if (!/^https?:\/\//i.test(url)) {
          const error = new Error(convert3dError(job, "Convert3D completed without a signed download URL"));
          error.code = "API";
          throw error;
        }
        return {
          files: [{ url, filename: "" }],
          remote: { provider: this.id, jobId }
        };
      }
      if (status === "failed") {
        const error = new Error(convert3dError(job, "Convert3D conversion failed"));
        error.code = "API";
        throw error;
      }

      await onState?.({
        stage: "converting",
        progress,
        detail: job?.message || `Convert3D: ${status || "processing"}`,
        remote: { provider: this.id, jobId }
      });
      await sleep(2500);
    }

    const error = new Error("Convert3D job timed out while waiting for completion");
    error.code = "TEMPORARY";
    throw error;
  }
};
