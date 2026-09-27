import { createHash, randomBytes } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const shortHash = (s: string) => sha256(s).slice(0, 16);
export const randomToken = (bytes = 24) => randomBytes(bytes).toString("base64url");

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

// HTML → plain paragraphs. Scripts/styles are dropped; nothing is executed.
export function htmlToParagraphs(html: string): string[] {
  const cleaned = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|section|article)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(cleaned)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length > 0);
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

// Canonical URL for dedupe: strip tracking params, fragments, trailing slash.
export function canonicalUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_src|s$|t$|fbclid|gclid|mc_|oc$|ved$|usg$)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.replace(/^www\.|^m\.|^mobile\./, "");
    let out = u.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}

export const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
  // Never expand DOCTYPE-declared entities from remote documents.
  allowBooleanAttributes: true,
});

export function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && v && "#text" in (v as any)) return String((v as any)["#text"]);
  return "";
}

export function isoOrNull(v: unknown): string | null {
  const s = text(v).trim();
  if (!s) return null;
  const d = new Date(s.replace(" UTC", "Z"));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function jaccard(a: string, b: string): number {
  const A = new Set(normalizeText(a).split(" ").filter((w) => w.length > 2));
  const B = new Set(normalizeText(b).split(" ").filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
