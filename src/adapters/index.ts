import { githubAdapter } from "./github.ts";
import { blogAdapter, newsAdapter, podcastAdapter, youtubeAdapter } from "./feeds.ts";
import { booksAdapter, federalRegisterAdapter, linkedinAdapter } from "./other.ts";
import { xAdapter } from "./x.ts";
import { bookfaceAdapter } from "./bookface.ts";
import { exaAdapter } from "./exa.ts";
import type { Adapter, PersonContext } from "./types.ts";
import { getDb } from "../db.ts";

export const manualAdapter: Adapter = {
  id: "manual",
  label: "Material you add (pasted URL / authorized upload)",
  kind: "manual",
  capabilities: {
    realtime: "none",
    content: "full",
    attributionMethod: "Declared by the user when adding the material",
    edits: false,
    deletions: false,
    backfill: false,
    notes: ["Pasted public URLs are fetched through the SSRF guard.", "Uploads require your statement that you may use the material."],
  },
  auth: { required: false, envVars: [], paid: false, note: "No credentials." },
  configured: () => true,
  discover: async () => [],
  collect: async () => ({ items: [], cursor: null, status: "polling" }),
};

export const ADAPTERS: Adapter[] = [
  xAdapter,
  githubAdapter,
  blogAdapter,
  youtubeAdapter,
  podcastAdapter,
  newsAdapter,
  booksAdapter,
  federalRegisterAdapter,
  linkedinAdapter,
  bookfaceAdapter,
  exaAdapter,
  manualAdapter,
];

export const adapterById = (id: string) => ADAPTERS.find((a) => a.id === id);

export function personContext(personId: string): PersonContext {
  const db = getDb();
  const p = db.query("SELECT id, name FROM persons WHERE id = ?").get(personId) as { id: string; name: string };
  const ids = db.query("SELECT kind, value, verified FROM identities WHERE person_id = ?").all(personId) as any[];
  return {
    id: p.id,
    name: p.name,
    aliases: ids.filter((i) => i.kind === "alias").map((i) => i.value),
    positions: ids.filter((i) => i.kind === "position").map((i) => i.value),
    identities: ids.filter((i) => !["alias", "position"].includes(i.kind)).map((i) => ({ kind: i.kind, value: i.value, verified: !!i.verified })),
  };
}

export function adapterReport() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    label: a.label,
    kind: a.kind,
    capabilities: a.capabilities,
    auth: { ...a.auth, configured: a.configured() },
  }));
}
