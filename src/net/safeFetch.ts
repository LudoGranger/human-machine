// Outbound fetch with SSRF protection. Every destination and every redirect hop
// is validated: http(s) only, no credentials in URL, and the resolved address
// must not be loopback / private / link-local / metadata ranges.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config.ts";

export class FetchBlockedError extends Error {}
export class HttpError extends Error {
  constructor(public status: number, public url: string, public retryAfterS: number | null, message: string) {
    super(message);
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchBlockedError(`invalid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new FetchBlockedError(`blocked scheme ${u.protocol}`);
  if (u.username || u.password) throw new FetchBlockedError("credentials in URL are not allowed");
  if (config.allowPrivateNetwork()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new FetchBlockedError(`blocked host ${host}`);
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new FetchBlockedError(`blocked private address ${a.address} for ${host}`);
  }
  return u;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeResponse {
  status: number;
  url: string;
  headers: Headers;
  text: string;
  notModified: boolean;
}

export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 5_000_000;
  let url = (await assertPublicUrl(raw)).toString();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
    opts.signal?.addEventListener("abort", () => ctl.abort());
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        redirect: "manual",
        signal: ctl.signal,
        headers: { "user-agent": config.userAgent(), accept: "*/*", ...opts.headers },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get("location");
      if (!loc) throw new HttpError(res.status, url, null, "redirect without location");
      url = (await assertPublicUrl(new URL(loc, url).toString())).toString();
      continue;
    }
    if (res.status === 304) return { status: 304, url, headers: res.headers, text: "", notModified: true };
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new HttpError(413, url, null, `response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    if (res.status >= 400) {
      const ra = res.headers.get("retry-after");
      const reset = res.headers.get("x-rate-limit-reset") || res.headers.get("x-ratelimit-reset");
      let retryAfterS: number | null = ra ? Number(ra) || null : null;
      if (!retryAfterS && reset) retryAfterS = Math.max(1, Number(reset) - Math.floor(Date.now() / 1000));
      throw new HttpError(res.status, url, retryAfterS, `HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
    }
    return { status: res.status, url, headers: res.headers, text, notModified: false };
  }
  throw new FetchBlockedError("too many redirects");
}
