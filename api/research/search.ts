import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import process from "node:process";
import { handleResearchSearchRequest } from "../../lib/researchService.ts";

interface VercelLikeRequest extends IncomingMessage {
  body?: unknown;
}

const MAX_BODY_BYTES = 16_384;

function readJsonBody(req: VercelLikeRequest): Promise<unknown> {
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      return Promise.resolve(JSON.parse(req.body || "{}"));
    }
    return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  extraHeaders?: Record<string, string>
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  res.end(JSON.stringify(payload));
}

export default async function handler(req: VercelLikeRequest, res: ServerResponse) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." }, { Allow: "POST" });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "PAYLOAD_TOO_LARGE") {
      sendJson(res, 413, { error: "Request payload too large." });
      return;
    }
    sendJson(res, 400, { error: "Invalid JSON request body." });
    return;
  }

  const forwardedFor = req.headers["x-forwarded-for"];
  const clientIp =
    (typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : undefined) ||
    req.socket?.remoteAddress ||
    "unknown";

  const result = await handleResearchSearchRequest({
    body,
    clientIp,
    apiKey: process.env.GEMINI_API_KEY
  });

  sendJson(res, result.status, result.payload, result.headers);
}
