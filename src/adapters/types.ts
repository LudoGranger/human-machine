import type { Attribution, SourceStatus } from "../schema.ts";

export type SourceKind = "social" | "repo" | "video" | "podcast" | "book" | "news" | "blog" | "official" | "manual";

export interface AdapterCapabilities {
  realtime: "stream" | "webhook" | "poll" | "none";
  content: "full" | "partial" | "metadata_only";
  attributionMethod: string; // how authorship is determined
  edits: boolean;
  deletions: boolean;
  backfill: boolean;
  notes: string[];
}

export interface AdapterAuth {
  required: boolean;
  envVars: string[];
  paid: boolean;
  note: string;
}

export interface PersonContext {
  id: string;
  name: string;
  aliases: string[];
  identities: { kind: string; value: string; verified: boolean }[];
  positions: string[]; // Wikidata position-held labels (e.g., "President of the United States")
}

export interface DiscoveredSource {
  adapter: string;
  kind: SourceKind;
  locator: string;
  label: string;
  mode: "stream" | "poll" | "historical" | "manual";
  pollIntervalS?: number;
  dailyBudget?: number;
  coverageGaps?: string[];
}

export interface RawPassage {
  locator: string;
  text: string;
  speaker: string | null;
  speakerIsSubject: boolean | null;
}

export interface RawItem {
  externalId: string;
  url: string | null;
  title: string | null;
  author: string | null;
  attribution: Attribution;
  relation: string;
  extraction: "full" | "partial" | "metadata_only";
  occurredAt: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  passages: RawPassage[];
  raw?: Record<string, unknown>;
  isHistorical?: boolean;
}

export interface SourceRow {
  id: string;
  person_id: string;
  adapter: string;
  kind: SourceKind;
  locator: string;
  label: string | null;
  mode: string;
  status: SourceStatus;
  cursor: string | null;
  etag: string | null;
  last_modified: string | null;
  last_success_at: string | null;
  created_at: string;
}

export interface CollectResult {
  items: RawItem[];
  cursor: string | null;
  etag?: string | null;
  lastModified?: string | null;
  notModified?: boolean;
  deletedExternalIds?: string[];
  gaps?: string[];
  status: SourceStatus; // status to display after a successful collection
}

export interface Adapter {
  id: string;
  label: string;
  kind: SourceKind;
  capabilities: AdapterCapabilities;
  auth: AdapterAuth;
  configured(): boolean; // credentials present (or none required)
  discover(person: PersonContext): Promise<DiscoveredSource[]>;
  collect(source: SourceRow, person: PersonContext, signal?: AbortSignal): Promise<CollectResult>;
}

export class AccessRequiredError extends Error {}
