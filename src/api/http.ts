/**
 * Minimal HTTP abstraction so that the API client works with Obsidian's
 * requestUrl (mobile-safe, no CORS) in the plugin and with a test client
 * (tests/helpers/fetchHttp.ts).
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
