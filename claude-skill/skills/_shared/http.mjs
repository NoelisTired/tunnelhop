// Shared HTTP helper for all ~/.claude skills.
// One place for: AbortController timeout, retry-with-backoff on transient
// failures (network errors + 5xx, NOT 4xx), tolerant text->JSON parsing, and
// friendly errors that distinguish timeout / network / auth / not-found /
// validation / server from each other.
//
// Usage:
//   import { fetchJson, HttpError } from "../../_shared/http.mjs";
//   const data = await fetchJson(url, { method: "POST", headers, body, timeoutMs, retries });

export class HttpError extends Error {
  constructor(message, { status, kind, body } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;       // numeric HTTP status, or undefined for network/timeout
    this.kind = kind;           // "timeout" | "network" | "auth" | "notfound" | "validation" | "server" | "client"
    this.body = body;           // parsed response body if any
  }
}

function classify(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "notfound";
  if (status === 422 || status === 400) return "validation";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "ok";
}

function friendly(kind, status, body) {
  const detail =
    body && typeof body === "object" && body.message
      ? body.message + (body.errors ? ": " + JSON.stringify(body.errors) : "")
      : typeof body === "string" && body
        ? body.slice(0, 300)
        : "";
  switch (kind) {
    case "timeout": return "request timed out";
    case "network": return `network error${detail ? ": " + detail : ""}`;
    case "auth": return `not authorized (HTTP ${status}): check the API key/token${detail ? ": " + detail : ""}`;
    case "notfound": return `not found (HTTP ${status})${detail ? ": " + detail : ""}`;
    case "validation": return `invalid request (HTTP ${status})${detail ? ": " + detail : ""}`;
    case "server": return `server error (HTTP ${status})${detail ? ": " + detail : ""}`;
    default: return `HTTP ${status}${detail ? ": " + detail : ""}`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch + timeout + retry, returning parsed JSON (or text if not JSON).
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method="GET"]
 * @param {object} [opts.headers]
 * @param {*} [opts.body]                request body (string/Buffer/FormData)
 * @param {number} [opts.timeoutMs=15000]
 * @param {number} [opts.retries=2]      retries on network error / 5xx (not 4xx)
 * @param {boolean} [opts.raw=false]     resolve the Response instead of parsing
 * @throws {HttpError}
 */
export async function fetchJson(url, opts = {}) {
  const { method = "GET", headers, body, timeoutMs = 15000, retries = 2, raw = false } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      if (!res.ok) {
        const kind = classify(res.status);
        // Retry only transient server errors.
        if (kind === "server" && attempt < retries) {
          lastErr = new HttpError(friendly(kind, res.status, data), { status: res.status, kind, body: data });
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw new HttpError(friendly(kind, res.status, data), { status: res.status, kind, body: data });
      }
      return raw ? res : data;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const kind = e.name === "AbortError" ? "timeout" : "network";
      lastErr = new HttpError(friendly(kind, undefined, e.message), { kind });
      if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
