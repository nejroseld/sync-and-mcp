/**
 * fetch-based HttpClient for tests and other non-Obsidian environments.
 * Lives outside src/ so the plugin bundle does not call fetch().
 * Plugin runtime uses requestUrl via src/api/httpObsidian.ts.
 */
import type { HttpClient } from "../../src/api/http";

export const fetchHttp: HttpClient = async (req) => {
  const body: BodyInit | undefined = req.body;
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return {
    status: res.status,
    headers,
    body: req.method === "HEAD" ? new ArrayBuffer(0) : await res.arrayBuffer(),
  };
};
