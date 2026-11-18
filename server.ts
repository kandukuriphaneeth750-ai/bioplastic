import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import { handleResearchSearchRequest } from "./lib/researchService.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === "production";
// In dev, AI Studio proxy uses PORT=8080 and routes traffic to DEFAULT_APP_PORT (3000).
// In production (Cloud Run), listen on the injected PORT (or 3000 fallback).
const PORT = isProduction
  ? Number(process.env.PORT || process.env.DEFAULT_APP_PORT || 3000)
  : Number(process.env.DEFAULT_APP_PORT || 3000);

async function startServer() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // Security headers middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (isProduction || req.secure || req.headers["x-forwarded-proto"] === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    }
    // Enforce frame-ancestors 'none' in standalone deployments while preserving AI Studio Preview iframe
    if (process.env.STANDALONE_ORIGIN === "true") {
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    }
    next();
  });

  app.use(express.json({ limit: "16kb" }));

  // Handle malformed JSON payloads gracefully instead of leaking HTML 400 pages
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "Invalid JSON request body." });
      return;
    }
    next(err);
  });

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/api/test-photos", (_req: Request, res: Response) => {
    const publicDir = path.resolve(__dirname, "public");
    const available: Record<string, boolean> = {};
    for (let i = 1; i <= 6; i++) {
      const rel = `images/test-${i}.jpg`;
      available[rel] = fs.existsSync(path.join(publicDir, rel));
    }
    res.json({ available });
  });

  app.post("/api/research/search", async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const result = await handleResearchSearchRequest({
      body: req.body,
      clientIp,
      apiKey: process.env.GEMINI_API_KEY
    });

    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
    }
    res.status(result.status).json(result.payload);
  });

  if (!isProduction) {
    process.env.DISABLE_HMR = "true";
    // Prevent Vite 8's client script from opening a failing WebSocket to port 24678 when HMR is disabled
    app.get("/@vite/client", (_req: Request, res: Response) => {
      res.type("application/javascript").send(`
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-vite-dev-id", id);
    style.textContent = content;
    document.head.appendChild(style);
  } else {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return { accept() {}, dispose() {}, prune() {}, invalidate() {}, decline() {}, on() {}, off() {}, send() {}, data: {} };
}
export function injectQuery(url) { return url; }
export class ErrorOverlay extends HTMLElement {}
`);
    });
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req: Request, res: Response) => {
      const indexHtml = path.join(distDir, "index.html");
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send("Build artifacts not found. Run npm run build first.");
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`FloraCycle server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start FloraCycle server:", err);
  process.exit(1);
});
