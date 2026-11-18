import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
}
