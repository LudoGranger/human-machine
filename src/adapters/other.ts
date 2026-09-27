// Books (metadata), official U.S. presidential documents (Federal Register),
// LinkedIn (recorded as inaccessible) and manual inputs (pasted URL / upload).
import { safeFetch } from "../net/safeFetch.ts";
import { readCursor, writeCursor } from "./github.ts";
import { AccessRequiredError, type Adapter, type RawItem, type RawPassage } from "./types.ts";
import { config } from "../config.ts";
import { htmlToParagraphs, slugify } from "../util.ts";

// ---------------------------------------------------------------------------
// Books are historical context. Discovery of an old title is never reported as
// a new development; only metadata is stored unless the text is public-domain,
// licensed, or an authorized user upload (handled by the manual adapter).
export const booksAdapter: Adapter = {
  id: "books",
  label: "Books (Open Library / Google Books metadata)",
  kind: "book",
  capabilities: {
    realtime: "none",
    content: "metadata_only",
    attributionMethod: "Author match on Open Library author record; editions and first-publish year kept",
    edits: false,
    deletions: false,
    backfill: true,
    notes: [
      "Metadata is not book access. Full text requires public-domain status, a license, or an authorized upload with edition and page/chapter references.",
      "Books are historical context: marked Historical, never 'new'.",
    ],
  },
  auth: { required: false, envVars: ["GOOGLE_BOOKS_API_KEY"], paid: false, note: "Open Library needs no key; Google Books key optional." },
  configured: () => true,
  async discover(person) {
    return [{ adapter: "books", kind: "book", locator: person.name, label: `Books by ${person.name}`, mode: "historical", pollIntervalS: 7 * 86400 }];
  },
  async collect(source, person) {
    const cursor = readCursor(source.cursor);
    const res = await safeFetch(
      `https://openlibrary.org/search.json?author=${encodeURIComponent(source.locator)}&fields=key,title,author_name,author_key,first_publish_year,edition_count,publisher,isbn&limit=20`,
    );
    const j = JSON.parse(res.text);
    const items: RawItem[] = [];
    for (const d of j.docs ?? []) {
      // Exact author-name match only; "Obama" in a co-author list is not enough.
      if (!(d.author_name ?? []).some((a: string) => a.toLowerCase() === person.name.toLowerCase())) continue;
      if (cursor.seen.includes(d.key)) continue;
      items.push({
        externalId: d.key,
        url: `https://openlibrary.org${d.key}`,
        title: d.title,
        author: (d.author_name ?? []).join(", "),
        attribution: (d.author_name ?? []).length > 1 ? "by_subject" : "by_subject",
        relation: "book",
        extraction: "metadata_only",
        occurredAt: d.first_publish_year ? `${d.first_publish_year}-01-01T00:00:00.000Z` : null,
        publishedAt: d.first_publish_year ? `${d.first_publish_year}-01-01T00:00:00.000Z` : null,
        updatedAt: null,
        passages: [{ locator: "catalog record", text: `${d.title} (first published ${d.first_publish_year ?? "unknown"}; ${d.edition_count ?? "?"} editions)`, speaker: null, speakerIsSubject: null }],
        raw: { authors: d.author_name, editions: d.edition_count, isbn_sample: (d.isbn ?? []).slice(0, 3), google_books_key: !!config.googleBooksKey() },
        isHistorical: true,
      });
    }
    return {
      items,
      cursor: writeCursor(cursor, items.map((i) => i.externalId), null),
      gaps: ["Book text not ingested (metadata only) unless you upload an authorized excerpt"],
      status: "historical",
    };
  },
};

// ---------------------------------------------------------------------------
// Federal Register: primary U.S. presidential documents (executive orders,
// proclamations, memoranda) signed by the president. These are official
// decisions/implemented actions — distinct from speeches or proposals.
export const PRESIDENT_SLUGS: Record<string, string> = {
  "donald trump": "donald-trump",
  "barack obama": "barack-obama",
  "joe biden": "joe-biden",
  "george w. bush": "george-w-bush",
  "william j. clinton": "william-j-clinton",
};

export const federalRegisterAdapter: Adapter = {
  id: "federal_register",
  label: "Federal Register (presidential documents)",
  kind: "official",
  capabilities: {
    realtime: "poll",
    content: "partial",
    attributionMethod: "Documents filed under the president's name in the Federal Register API",
    edits: true,
    deletions: false,
    backfill: true,
    notes: [
      "Official primary documents (executive orders, proclamations, memoranda). Signing = official decision; implementation is a separate fact.",
      "Signing date = occurred; publication date = published. Official text fetched for recent documents.",
    ],
  },
  auth: { required: false, envVars: [], paid: false, note: "Public API, no key." },
  configured: () => true,
  async discover(person) {
    const slug = PRESIDENT_SLUGS[person.name.toLowerCase()];
    const isPresident = person.positions.some((p) => /president of the united states/i.test(p));
    if (!slug || !isPresident) return [];
    return [{ adapter: "federal_register", kind: "official", locator: slug, label: "Presidential documents (Federal Register)", mode: "poll", pollIntervalS: 6 * 3600 }];
  },
  async collect(source, person) {
    const cursor = readCursor(source.cursor);
    const q = new URLSearchParams({ per_page: "20", order: "newest", "conditions[type][]": "PRESDOCU", "conditions[president]": source.locator });
    for (const f of ["document_number", "title", "abstract", "signing_date", "publication_date", "html_url", "raw_text_url", "subtype", "executive_order_number", "citation"])
      q.append("fields[]", f);
    const res = await safeFetch(`https://www.federalregister.gov/api/v1/documents.json?${q}`);
    const j = JSON.parse(res.text);
    const items: RawItem[] = [];
    let fetchedText = 0;
    for (const d of j.results ?? []) {
      if (cursor.seen.includes(d.document_number)) continue;
      const passages: RawPassage[] = [{ locator: "title", text: d.title, speaker: person.name, speakerIsSubject: true }];
      if (d.abstract) passages.push({ locator: "abstract", text: d.abstract, speaker: null, speakerIsSubject: null });
      const signed = d.signing_date ? `${d.signing_date}T12:00:00.000Z` : null;
      const recent = signed ? Date.now() - Date.parse(signed) <= 60 * 86_400_000 : false;
      let fullText = false;
      if (recent && d.raw_text_url && fetchedText < 6) {
        try {
          const t = await safeFetch(d.raw_text_url, { maxBytes: 1_500_000 });
          const paras = t.text.replace(/<[^>]+>/g, "").split(/\n\s*\n/).map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length > 60);
          // The signed text is the president's official act; header boilerplate is skipped by the length filter.
          paras.slice(0, 40).forEach((x, n) => passages.push({ locator: `official text para ${n + 1}`, text: x.slice(0, 3000), speaker: person.name, speakerIsSubject: true }));
          fullText = paras.length > 0;
          fetchedText++;
        } catch {
          /* keep metadata; gap recorded below */
        }
      }
      items.push({
        externalId: d.document_number,
        url: d.html_url,
        title: d.title,
        author: person.name,
        attribution: "by_subject",
        relation: "official_document",
        extraction: fullText ? "full" : d.abstract ? "partial" : "metadata_only",
        occurredAt: signed,
        publishedAt: d.publication_date ? `${d.publication_date}T12:00:00.000Z` : null,
        updatedAt: null,
        passages,
        raw: { type: d.subtype ?? null, eo: d.executive_order_number, citation: d.citation, statement_type: "official_decision" },
        isHistorical: !recent,
      });
    }
    return {
      items,
      cursor: writeCursor(cursor, items.map((i) => i.externalId), null),
      gaps: ["Official text fetched for up to 6 recent documents per poll; older documents are metadata only", "Speeches and remarks are not in the Federal Register"],
      status: "polling",
    };
  },
};

// ---------------------------------------------------------------------------
export const linkedinAdapter: Adapter = {
  id: "linkedin",
  label: "LinkedIn",
  kind: "social",
  capabilities: {
    realtime: "none",
    content: "metadata_only",
    attributionMethod: "n/a",
    edits: false,
    deletions: false,
    backfill: false,
    notes: [
      "LinkedIn offers no public API for reading another member's posts; scraping would bypass access controls and is not done.",
      "Paste a LinkedIn post URL's text via Add material to include it as a supplemental input.",
    ],
  },
  auth: { required: true, envVars: [], paid: false, note: "No authorized integration available for third-party member posts." },
  configured: () => false,
  async discover(person) {
    return person.identities
      .filter((i) => i.kind === "linkedin")
      .map((i) => ({ adapter: "linkedin", kind: "social" as const, locator: i.value, label: `linkedin.com/in/${i.value}`, mode: "manual" as const, coverageGaps: ["No authorized access; not collected"] }));
  },
  async collect() {
    throw new AccessRequiredError("LinkedIn member posts are not accessible through an authorized API");
  },
};

// ---------------------------------------------------------------------------
// Manual inputs: a pasted public URL (fetched through the SSRF guard) or text
// the user is authorized to provide (e.g., a transcript they own, a licensed
// book excerpt with edition + page references). The user declares attribution.
export interface ManualInput {
  url?: string;
  text?: string;
  title?: string;
  attribution: "by_subject" | "about_subject" | "interview";
  occurredAt?: string | null;
  publishedAt?: string | null;
  locatorPrefix?: string; // e.g. "Edition 2019, ch. 3"
  speaker?: string | null;
  rightsNote: string; // user statement of permission
}

export async function manualToItem(input: ManualInput, personName: string): Promise<RawItem> {
  let paras: string[] = [];
  let url: string | null = input.url ?? null;
  let title = input.title ?? null;
  if (input.text) paras = input.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  else if (input.url) {
    const res = await safeFetch(input.url, { maxBytes: 3_000_000 });
    url = res.url;
    title ??= res.text.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]?.trim() ?? null;
    const main = res.text.match(/<(article|main)[\s\S]*?<\/\1>/i)?.[0] ?? res.text;
    paras = htmlToParagraphs(main).filter((p) => p.length > 40);
  }
  if (!paras.length) throw new Error("no readable text in the supplied material");
  const speakerIsSubject = input.attribution === "by_subject" ? true : input.attribution === "about_subject" ? false : null;
  return {
    externalId: `manual-${slugify(title ?? url ?? paras[0].slice(0, 40))}-${Date.now()}`,
    url,
    title,
    author: input.attribution === "by_subject" ? personName : null,
    attribution: input.attribution,
    relation: "upload",
    extraction: "full",
    occurredAt: input.occurredAt ?? null,
    publishedAt: input.publishedAt ?? null,
    updatedAt: null,
    passages: paras.slice(0, 200).map((t, i) => ({
      locator: `${input.locatorPrefix ? input.locatorPrefix + ", " : ""}para ${i + 1}`,
      text: t.slice(0, 4000),
      speaker: input.speaker ?? (input.attribution === "by_subject" ? personName : null),
      speakerIsSubject,
    })),
    raw: { rights_note: input.rightsNote },
  };
}
