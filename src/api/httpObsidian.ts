import { requestUrl } from "obsidian";
import type { HttpClient } from "./http";

/** Obsidian requestUrl-based client; never throws on HTTP error statuses. */
export const obsidianHttp: HttpClient = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  return {
    status: res.status,
    headers,
    body: req.method === "HEAD" ? new ArrayBuffer(0) : res.arrayBuffer,
  };
};
