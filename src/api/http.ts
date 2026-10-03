/**
 * Minimal HTTP abstraction so that the API client works with Obsidian's
 * requestUrl (mobile-safe, no CORS) in the plugin and with fetch in tests.
 */
export interface HttpRequest {
  url: string;
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD" | "PATCH";
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface HttpResponse {
  status: number;
  /** header names are lower-cased */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/** fetch-based client (tests, or non-Obsidian environments) */
export const fetchHttp: HttpClient = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body as any,
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
