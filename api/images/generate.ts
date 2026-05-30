import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  dataUrlFromBase64,
  detailFromError,
  endpoint,
  fetchWithTimeout,
  fullPrompt,
  getManagedUpstreamConfig,
  getProtocol,
  imageSizeForRequest,
  isImage2Model,
  normalizeReferences,
  outputMime,
  readJsonBody,
  sendJson,
  urlToDataUrl,
  type GenerateRequest,
} from "../_shared.js";

async function readOpenAiImageResponse(response: Response, outputFormat: string) {
  const bodyText = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    json = bodyText;
  }
  if (!response.ok) {
    return { ok: false, status: response.status, detail: { status: response.status, error: `HTTP ${response.status}`, raw: json } };
  }
  const data = json && typeof json === "object" ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) {
    return { ok: false, status: response.status, detail: { status: response.status, error: "接口返回格式不是 images API 格式", raw: json } };
  }

  const mime = outputMime(outputFormat);
  const images = await Promise.all(data.map(async (item) => {
    if (!item || typeof item !== "object") return null;
    const record = item as { b64_json?: string; url?: string; revised_prompt?: string };
    if (record.b64_json) {
      return { dataUrl: dataUrlFromBase64(record.b64_json, mime), revisedPrompt: record.revised_prompt || "" };
    }
    if (record.url) {
      return { dataUrl: await urlToDataUrl(record.url), revisedPrompt: record.revised_prompt || "" };
    }
    return null;
  }));

  const usableImages = images.filter(Boolean);
  if (!usableImages.length) {
    return { ok: false, status: response.status, detail: { status: response.status, error: "接口没有返回可识别的图片数据", raw: json } };
  }
  return { ok: true, status: response.status, images: usableImages, raw: json };
}

function dataUri(image: { dataUrl: string; type?: string }) {
  if (image.dataUrl.startsWith("data:")) return image.dataUrl;
  return `data:${image.type || "image/png"};base64,${image.dataUrl}`;
}

async function generateCompatible(baseUrl: string, apiKey: string, request: GenerateRequest) {
  const protocol = getProtocol(request.protocol);
  const outputFormat = request.outputFormat || "png";
  const payload: Record<string, unknown> = {
    model: request.model,
    prompt: fullPrompt(request),
    n: 1,
    response_format: "b64_json",
  };
  const size = imageSizeForRequest(request);
  if (size && size !== "auto") payload.size = size;
  if (request.quality && request.quality !== "auto") payload.quality = request.quality;
  if (outputFormat && outputFormat !== "png") payload.output_format = outputFormat;
  if (request.aspectRatio && protocol === "custom-openai" && !isImage2Model(request.model)) {
    payload.aspect_ratio = request.aspectRatio;
  }

  const references = normalizeReferences(request.referenceImages);
  if (references.length > 0) {
    payload.image = references.map(dataUri);
  }

  const response = await fetchWithTimeout(endpoint(baseUrl, "/v1/images/generations"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  return readOpenAiImageResponse(response, outputFormat);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const requestId = randomUUID();
  try {
    const body = await readJsonBody(req);
    const request = body.request && typeof body.request === "object"
      ? body.request as GenerateRequest
      : {};
    if (!request.model || !request.prompt) {
      sendJson(res, 400, { ok: false, requestId, detail: { error: "模型和提示词不能为空" } });
      return;
    }

    const managed = await getManagedUpstreamConfig();
    request.protocol = getProtocol(request.protocol || managed.protocol);
    const result = await generateCompatible(managed.baseUrl, managed.apiKey, request);
    if (!result.ok) {
      sendJson(res, result.status || 500, { ok: false, requestId, detail: result.detail });
      return;
    }
    sendJson(res, 200, { ok: true, requestId, status: result.status, images: result.images, raw: result.raw });
  } catch (error) {
    sendJson(res, 500, { ok: false, requestId, detail: detailFromError(error) });
  }
}
