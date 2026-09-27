// Mirrors the evidence graph into GBrain and retrieves from it.
//   public layer : evidence/<person>/<item>, claims/<person>/<id>, rules/<person>/<id>, people/<person>
//   app layer    : interpretations/<person>/<change_event>
//   private:<uid>: goals/<person>, cards/<card>, outcomes/<card>
// Source text is written as blockquotes (quoteUntrusted) and every page names
// its provenance, so retrieved chunks can be traced back to original sources.
import { getDb } from "../db.ts";
import { putPage, quoteUntrusted, searchPages, yamlStr, type Layer, type SearchHit } from "../gbrain/client.ts";

export async function syncItem(itemId: string): Promise<string> {
  const db = getDb();
  const it = db.query("SELECT i.*, s.adapter, s.label AS source_label FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?").get(itemId) as any;
  if (!it) return "missing";
  const person = db.query("SELECT name FROM persons WHERE id = ?").get(it.person_id) as { name: string };
  const passages = db.query("SELECT * FROM passages WHERE item_id = ? AND version = ? ORDER BY rowid").all(itemId, it.current_version) as any[];
  const ver = db.query("SELECT content_hash, raw FROM item_versions WHERE item_id = ? AND version = ?").get(itemId, it.current_version) as any;
  const raw = JSON.parse(ver?.raw ?? "{}");
  const md = `---
title: ${yamlStr(`${person.name} — ${it.title ?? it.relation}`)}
type: source
tags: [human-machine, evidence, ${it.person_id}, ${it.adapter}]
hm_item_id: ${itemId}
hm_person: ${it.person_id}
attribution: ${it.attribution}
relation: ${it.relation}
extraction: ${it.extraction}
url: ${yamlStr(it.url)}
occurred_at: ${yamlStr(it.occurred_at)}
published_at: ${yamlStr(it.published_at)}
discovered_at: ${yamlStr(it.discovered_at)}
version: ${it.current_version}
content_hash: ${ver?.content_hash ?? "null"}
deleted: ${it.deleted_at ? "true" : "false"}
trust: untrusted-public-content
---

# ${person.name}: ${(it.title ?? it.relation).replace(/\n/g, " ").slice(0, 160)}

Source: ${it.source_label} (${it.adapter}) · ${it.url ?? "no URL"}
Attribution: **${it.attribution}** · Relation: ${it.relation} · Extraction: ${it.extraction}
${raw.co_authors?.length ? `Co-authors recorded on this change: ${raw.co_authors.join("; ")}\n` : ""}Occurred: ${it.occurred_at ?? "unknown"} · Published: ${it.published_at ?? "unknown"} · Discovered: ${it.discovered_at}

${it.deleted_at ? "_This item was deleted by its author; text removed._" : passages
    .map((p) => `### ${p.locator} — speaker: ${p.speaker ?? "unknown"}${p.speaker_is_subject === 1 ? " (the person)" : p.speaker_is_subject === 0 ? " (not the person)" : ""}\n\n${quoteUntrusted(p.text.slice(0, 3000))}`)
    .join("\n\n")}
`;
  // Restricted sources (Bookface) never enter the public brain.
  return putPage(it.restricted ? "private:local" : "public", `evidence/${it.person_id}/${itemId}`, md);
}

export async function syncClaimsAndRules(personId: string): Promise<{ claims: number; rules: number }> {
  const db = getDb();
  const person = db.query("SELECT * FROM persons WHERE id = ?").get(personId) as any;
  const claims = db.query("SELECT * FROM claims WHERE person_id = ?").all(personId) as any[];
  let nc = 0, nr = 0;
  for (const c of claims) {
    const ev = db
      .query(
        `SELECT ce.relation, ce.quote, p.locator, i.id item_id, i.url, i.published_at, i.occurred_at FROM claim_evidence ce
         JOIN passages p ON p.id = ce.passage_id JOIN items i ON i.id = p.item_id WHERE ce.claim_id = ? AND (i.restricted = 0 OR ? = 1)
         ORDER BY COALESCE(i.occurred_at, i.published_at)`,
      )
      .all(c.id, c.restricted ? 1 : 0) as any[]; // public pages never quote restricted sources
    const hist = db.query("SELECT version, statement, status, recorded_at FROM claim_history WHERE claim_id = ? ORDER BY version").all(c.id) as any[];
    const md = `---
title: ${yamlStr(`${person.name}: ${c.topic}`)}
type: concept
tags: [human-machine, claim, ${personId}, ${c.kind}, ${c.status}]
hm_claim_id: ${c.id}
hm_person: ${personId}
status: ${c.status}
version: ${c.version}
first_evidence_at: ${yamlStr(c.first_evidence_at)}
last_evidence_at: ${yamlStr(c.last_evidence_at)}
---

# ${person.name} — ${c.topic}

**Attributed paraphrase (${c.kind}, ${c.status}, v${c.version}):** ${c.statement}

## Evidence
${ev.map((e) => `- ${e.relation} · ${(e.occurred_at ?? e.published_at ?? "undated").slice(0, 10)} · [[evidence/${personId}/${e.item_id}]] (${e.locator}) ${e.url ?? ""}\n${quoteUntrusted(e.quote ?? "")}`).join("\n")}

## Position history
${hist.map((h) => `- v${h.version} (${h.status}, recorded ${h.recorded_at.slice(0, 10)}): ${h.statement}`).join("\n")}
`;
    if ((await putPage(c.restricted ? "private:local" : "public", `claims/${personId}/${c.id}`, md)) === "written") nc++;
  }
  const rules = db.query("SELECT * FROM rules WHERE person_id = ?").all(personId) as any[];
  for (const r of rules) {
    const d = JSON.parse(r.data);
    const ev = db
      .query("SELECT p.locator, i.id item_id, i.url FROM rule_evidence re JOIN passages p ON p.id = re.passage_id JOIN items i ON i.id = p.item_id WHERE re.rule_id = ? AND (i.restricted = 0 OR ? = 1)")
      .all(r.id, r.restricted ? 1 : 0) as any[];
    const md = `---
title: ${yamlStr(`${person.name} method: ${d.principle.slice(0, 90)}`)}
type: concept
tags: [human-machine, rule, ${personId}, ${r.status}, ${r.attribution}]
hm_rule_id: ${r.id}
status: ${r.status}
attribution: ${r.attribution}
evidence_strength: ${d.evidence_strength}
---

# Method (${r.attribution}, ${r.status}): ${d.principle}

Domain: ${d.domain}
Use when: ${d.activation_conditions.join("; ")}
Needs: ${d.required_information.join("; ") || "—"}
Procedure:
${d.procedure.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}
Decision criteria: ${d.decision_criteria.join("; ") || "—"}
Tradeoffs: ${d.tradeoffs.join("; ") || "—"}
Stop / exceptions: ${d.exceptions_and_stop_conditions.join("; ") || "—"}
Evidence strength: ${d.evidence_strength} — ${d.evidence_strength_explanation}
Example use: ${d.example_use}
Example non-use: ${d.example_non_use}

## Supporting evidence
${ev.map((e) => `- [[evidence/${personId}/${e.item_id}]] (${e.locator}) ${e.url ?? ""}`).join("\n")}
`;
    if ((await putPage(r.restricted ? "private:local" : "public", `rules/${personId}/${r.id}`, md)) === "written") nr++;
  }
  // Person hub page
  const ids = db.query("SELECT kind, value, verified FROM identities WHERE person_id = ?").all(personId) as any[];
  await putPage(
    "public",
    `people/${personId}`,
    `---
title: ${yamlStr(person.name)}
type: person
tags: [human-machine, person]
wikidata: ${yamlStr(person.wikidata_id)}
---

# ${person.name}

${person.description ?? ""}

## Identity
${ids.filter((i) => !["alias", "position"].includes(i.kind)).map((i) => `- ${i.kind}: ${i.value} (${i.verified ? "independently confirmed" : "asserted"})`).join("\n")}

## Tracked claims
${claims.filter((c) => !c.restricted).map((c) => `- [[claims/${personId}/${c.id}]] ${c.topic} (${c.status})`).join("\n")}

## Methods
${rules.filter((r) => !r.restricted).map((r) => `- [[rules/${personId}/${r.id}]] ${JSON.parse(r.data).principle.slice(0, 100)} (${r.status})`).join("\n")}
`,
  );
  return { claims: nc, rules: nr };
}

export async function syncInterpretation(eventId: string) {
  const db = getDb();
  const e = db.query("SELECT ce.*, p.name FROM change_events ce JOIN persons p ON p.id = ce.person_id WHERE ce.id = ?").get(eventId) as any;
  if (!e) return;
  await putPage(
    "app",
    `interpretations/${e.person_id}/${e.id}`,
    `---
title: ${yamlStr(`Interpretation: ${e.name} — ${e.classification}`)}
type: note
tags: [human-machine, interpretation, app-generated, ${e.person_id}]
generated_by: human-machine analysis (not the person's words)
---

Classification: **${e.classification}** · stale: ${e.stale ? "yes — " + e.stale_reason : "no"}
Summary (app paraphrase): ${e.summary}
Interpretation (app): ${e.interpretation ?? "—"}
Ranking: ${e.rank_explanation}
Evidence: ${JSON.parse(e.passage_ids).join(", ")} → public layer evidence/${e.person_id}/${e.item_id}
`,
  );
}

export async function syncPrivate(userId: string, slug: string, md: string) {
  return putPage(`private:${userId}` as Layer, slug, md);
}

export interface EvidenceHit extends SearchHit {
  itemId: string | null;
  url: string | null;
  publishedAt: string | null;
  attribution: string | null;
}

// Retrieval THROUGH GBrain: hits are mapped back to stored items so every
// retrieved chunk has an original source and dates.
export async function evidenceQuery(personId: string, query: string, limit = 8): Promise<EvidenceHit[]> {
  const hits = await searchPages("public", `${query}`, limit * 3);
  const db = getDb();
  const out: EvidenceHit[] = [];
  for (const h of hits) {
    const m = h.slug.match(/^(evidence|claims|rules)\/([^/]+)\/(.+)$/);
    if (!m || m[2] !== personId) continue;
    let itemId: string | null = null;
    if (m[1] === "evidence") itemId = m[3];
    else if (m[1] === "claims") {
      const r = db.query("SELECT p.item_id FROM claim_evidence ce JOIN passages p ON p.id = ce.passage_id WHERE ce.claim_id = ? LIMIT 1").get(m[3]) as any;
      itemId = r?.item_id ?? null;
    } else {
      const r = db.query("SELECT p.item_id FROM rule_evidence re JOIN passages p ON p.id = re.passage_id WHERE re.rule_id = ? LIMIT 1").get(m[3]) as any;
      itemId = r?.item_id ?? null;
    }
    const it = itemId ? (db.query("SELECT url, published_at, attribution, deleted_at FROM items WHERE id = ?").get(itemId) as any) : null;
    if (it?.deleted_at) continue;
    out.push({ ...h, itemId, url: it?.url ?? null, publishedAt: it?.published_at ?? null, attribution: it?.attribution ?? null });
    if (out.length >= limit) break;
  }
  return out;
}
