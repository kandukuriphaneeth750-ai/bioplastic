import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=60");

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }

  const publicDir = path.resolve(process.cwd(), "public");
  const distDir = path.resolve(process.cwd(), "dist");
  const available: Record<string, boolean> = {};

  for (let i = 1; i <= 6; i++) {
    const rel = `images/test-${i}.jpg`;
    available[rel] =
      fs.existsSync(path.join(publicDir, rel)) || fs.existsSync(path.join(distDir, rel));
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ available }));
}
