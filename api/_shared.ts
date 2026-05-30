import { createClient } from "@supabase/supabase-js";
import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

export type ImageProtocol =
  | "custom-openai"
  | "openai-images"
  | "openai-responses"
  | "gemini-native"
  | "gemini-openai"
  | "google-imagen"
  | "stability-core";

export type ReferenceImage = {
  dataUrl: string;
  name: string;
  type: string;
};

export type GenerateRequest = {
  protocol?: ImageProtocol;
  model?: string;
  prompt?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  outputFormat?: string;
  seed?: string;
  negativePrompt?: string;
  referenceImages?: ReferenceImage[];
};

type ManagedUpstreamConfig = {
  baseUrl: string;
  apiKey: string;
  protocol: ImageProtocol;
  defaultModel: string;
  analysisModel: string;
  channelLabel: string;
};

const DEFAULT_PROTOCOL: ImageProtocol = "custom-openai";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 180_000;

const DEFAULT_MODELS: Record<ImageProtocol, string[]> = {
  "custom-openai": ["gpt-image-2", "gpt-5.4-image-2"],
  "openai-images": ["gpt-image-2", "gpt-5.4-image-2"],
  "openai-responses": ["gpt-4.1", "gpt-4.1-mini"],
  "gemini-native": ["gemini-2.5-flash-image", "gemini-2.0-flash-preview-image-generation"],
  "gemini-openai": ["gemini-2.5-flash-image"],
  "google-imagen": ["imagen-4.0-generate-001", "imagen-4.0-ultra-generate-001", "imagen-3.0-generate-002"],
  "stability-core": ["stable-image-core", "stable-image-ultra"],
};

const PROTOCOLS = Object.keys(DEFAULT_MODELS) as ImageProtocol[];

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ADMIN_CLIENT = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

export function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const maybeBody = (req as IncomingMessage & { body?: unknown }).body;
  if (maybeBody && typeof maybeBody === "object") return maybeBody as Record<string, unknown>;
  if (typeof maybeBody === "string") {
    return JSON.parse(maybeBody || "{}") as Record<string, unknown>;
  }

  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error("请求体过大，请减少参考图数量或压缩图片"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error("请求体不是有效 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function getProtocol(value: unknown): ImageProtocol {
  return PROTOCOLS.includes(value as ImageProtocol) ? value as ImageProtocol : DEFAULT_PROTOCOL;
}

export function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function detailFromError(error: unknown) {
  if (error instanceof Error) return { error: error.message };
  if (error && typeof error === "object") return error;
  return { error: String(error || "未知错误") };
}

export function dataUrlFromBase64(base64: string, mime: string) {
  if (base64.startsWith("data:")) return base64;
  return `data:${mime};base64,${base64}`;
}

export function outputMime(outputFormat = "png") {
  const format = outputFormat.toLowerCase();
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

export async function urlToDataUrl(url: string) {
  const response = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
  if (!response.ok) throw new Error(`读取图片 URL 失败：HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/png";
  const bytes = Buffer.from(await response.arrayBuffer()).toString("base64");
  return `data:${contentType};base64,${bytes}`;
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractModelIds(payload: unknown, key: "data" | "models" = "data") {
  const source = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(source)) return [];
  return source
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as { id?: string; name?: string; displayName?: string };
      return String(record.id || record.name || record.displayName || "").replace(/^models\//, "").trim();
    })
    .filter(Boolean);
}

async function loadManagedUpstreamConfigFromSupabase(): Promise<ManagedUpstreamConfig | null> {
  if (!SUPABASE_ADMIN_CLIENT) return null;
  const { data, error } = await SUPABASE_ADMIN_CLIENT
    .from("app_settings")
    .select("upstream_protocol, upstream_base_url, upstream_api_key, upstream_default_model, upstream_analysis_model, upstream_channel_label")
    .eq("id", "default")
    .maybeSingle();
  if (error || !data) return null;
  const baseUrl = normalizeBaseUrl(String(data.upstream_base_url || ""));
  const apiKey = String(data.upstream_api_key || "").trim();
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    protocol: getProtocol(data.upstream_protocol),
    defaultModel: String(data.upstream_default_model || "").trim(),
    analysisModel: String(data.upstream_analysis_model || "").trim(),
    channelLabel: String(data.upstream_channel_label || "").trim(),
  };
}

export async function getManagedUpstreamConfig(): Promise<ManagedUpstreamConfig> {
  const adminConfig = await loadManagedUpstreamConfigFromSupabase();
  if (adminConfig) return adminConfig;

  const baseUrl = normalizeBaseUrl(
    process.env.UPSTREAM_API_BASE_URL || process.env.ALLOWED_API_BASE_URLS?.split(",")[0] || "",
  );
  const apiKey = (process.env.UPSTREAM_API_KEY || "").trim();
  if (!baseUrl) throw new Error("未配置 UPSTREAM_API_BASE_URL 或管理员中转地址");
  if (!apiKey) throw new Error("未配置 UPSTREAM_API_KEY 或管理员 API Key");
  return {
    baseUrl,
    apiKey,
    protocol: DEFAULT_PROTOCOL,
    defaultModel: "",
    analysisModel: "",
    channelLabel: "",
  };
}

export async function loadUpstreamModels(protocol: ImageProtocol, baseUrl: string, apiKey: string) {
  if (!apiKey || protocol === "stability-core") {
    return { models: DEFAULT_MODELS[protocol], raw: { source: "preset" } };
  }

  const path = protocol === "gemini-native" || protocol === "google-imagen"
    ? "/models"
    : protocol === "gemini-openai"
      ? "/models"
      : "/v1/models";
  const headers = protocol === "gemini-native" || protocol === "google-imagen"
    ? { "x-goog-api-key": apiKey }
    : { Authorization: `Bearer ${apiKey}` };
  const response = await fetchWithTimeout(endpoint(baseUrl, path), { headers });
  const text = await response.text();
  const payload = parseMaybeJson(text);
  if (!response.ok) {
    throw { status: response.status, error: `HTTP ${response.status}`, raw: payload };
  }
  const models = extractModelIds(payload, protocol === "gemini-native" || protocol === "google-imagen" ? "models" : "data");
  return { models: models.length ? models : DEFAULT_MODELS[protocol], raw: payload };
}

const SIZE_BY_RATIO: Record<string, string> = {
  "1:1": "1024x1024",
  "4:5": "1024x1280",
  "5:4": "1280x1024",
  "3:4": "1152x1536",
  "4:3": "1536x1152",
  "2:3": "1024x1536",
  "3:2": "1536x1024",
  "9:16": "1024x1792",
  "16:9": "1792x1024",
  "21:9": "2016x864",
  "9:21": "864x2016",
};

export function isImage2Model(model = "") {
  const normalized = model.toLowerCase();
  return normalized === "gpt-image-2" || normalized === "gpt-5.4-image-2" || normalized.includes("image-2");
}

export function imageSizeForRequest(request: GenerateRequest) {
  if (isImage2Model(request.model) && request.aspectRatio) {
    return SIZE_BY_RATIO[request.aspectRatio] || SIZE_BY_RATIO["1:1"];
  }
  return request.size || (request.aspectRatio ? SIZE_BY_RATIO[request.aspectRatio] : "") || "1024x1024";
}

export function fullPrompt(request: GenerateRequest) {
  return request.negativePrompt
    ? `${request.prompt || ""}\n\nNegative prompt: ${request.negativePrompt}`
    : request.prompt || "";
}

export function normalizeReferences(value: unknown): ReferenceImage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is ReferenceImage => {
      return Boolean(item)
        && typeof item === "object"
        && typeof (item as ReferenceImage).dataUrl === "string"
        && (item as ReferenceImage).dataUrl.length > 0;
    })
    .slice(0, 4);
}

