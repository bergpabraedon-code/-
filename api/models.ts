import type { IncomingMessage, ServerResponse } from "node:http";
import {
  detailFromError,
  getManagedUpstreamConfig,
  getProtocol,
  loadUpstreamModels,
  readJsonBody,
  sendJson,
} from "./_shared.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const managed = await getManagedUpstreamConfig();
    const protocol = getProtocol(body.protocol || managed.protocol);
    const { models, raw } = await loadUpstreamModels(protocol, managed.baseUrl, managed.apiKey);
    sendJson(res, 200, {
      ok: true,
      models: [...new Set(models)].sort(),
      defaultModel: managed.defaultModel,
      analysisModel: managed.analysisModel,
      channelLabel: managed.channelLabel,
      raw,
    });
  } catch (error) {
    const detail = detailFromError(error);
    const status = typeof (detail as { status?: unknown }).status === "number"
      ? (detail as { status: number }).status
      : 500;
    sendJson(res, status, { ok: false, detail });
  }
}
