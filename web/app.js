// Human Machine web UI — vanilla JS, no build step. All collected text is
// inserted with textContent-equivalent escaping; nothing from sources is
// rendered as HTML.
const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "unknown");
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "undated");
const ago = (iso) => {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const STATUS_LABEL = { live: "Live", polling: "Polling", delayed: "Delayed", historical: "Historical", access_required: "Access required", failed: "Failed", pending: "Queued" };
const chip = (s) => `<span class="chip ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const RESEARCH_LABEL = {
  not_started: "Not researched yet", resolving: "Resolving identity…", needs_clarification: "Needs clarification", researching: "Researching…",
  partial: "Researched (partial coverage)", researched: "Researched", failed: "Research failed",
};
const CLS_LABEL = {
  new_topic: "New topic or method", additional_support: "Additional support", refinement: "Refinement / exception", contradiction: "Contradiction",
  reversal: "Explicit reversal", retraction: "Retraction", repetition: "Repetition", unclear: "Unclear",
};
let STATUS = null;
let timer = null;

async function loadStatus() {
  try {
    STATUS = await api("/api/status");
    const s = STATUS;
    const layers = s.gbrain.layers;
    const gOk = layers.length && layers.every((l) => l.ok !== false);
    document.getElementById("sysstatus").innerHTML = [
      `<span class="${s.worker.alive ? "ok" : "bad"}">Worker ${s.worker.alive ? "running" : "stopped"}</span>`,
      `<span class="${s.llm.provider === "none" ? "bad" : "ok"}">Model: ${esc(s.llm.provider === "none" ? "not configured" : `${s.llm.provider} · ${s.llm.model}`)}</span>`,
      `<span class="${gOk ? "ok" : "bad"}">GBrain: ${layers.length ? layers.map((l) => `${esc(l.layer.replace("private:", "private/"))} ${l.ok === false ? "✗" : "✓"}`).join(" · ") : "no writes yet"}</span>`,
    ].join("");
  } catch (e) {
    document.getElementById("sysstatus").innerHTML = `<span class="bad">Server unreachable</span>`;
  }
}

function route() {
  clearInterval(timer);
  const h = location.hash.replace(/^#\/?/, "");
  const [kind, id, tab] = h.split("/");
  if (kind === "p" && id) return person(id, tab || "overview");
  return landing();
}
window.addEventListener("hashchange", route);

// ---------------------------------------------------------------- Landing
async function landing() {
  const persons = await api("/api/persons").catch(() => []);
  const featured = persons.filter((p) => p.featured);
  const others = persons.filter((p) => !p.featured);
  const card = (p) => `<a class="pcard" href="#/p/${esc(p.id)}">
      <span class="name">${esc(p.name)}</span>
      <span class="small muted">${esc(RESEARCH_LABEL[p.research_status] || p.research_status)}</span>
      <span class="small muted">${p.items ? `${p.items} items · ${p.changes} changes · ${p.sources} sources` : "No material collected"}</span>
      ${p.last_discovered ? `<span class="small muted">Last discovery ${esc(ago(p.last_discovered))}</span>` : ""}
    </a>`;
  $app.innerHTML = `
    <section class="hero">
      <h1>Human Machine</h1>
      <p class="tag">Own <s>Your</s> Their Intelligence</p>
      <p class="choose">Choose your human.</p>
      <p class="sub">Get their real-time thinking about the world to improve your daily outcomes with AI.</p>
      <form class="search" id="f"><input id="q" placeholder="Enter a name, e.g. Garry Tan" aria-label="Person name" autocomplete="off"><button class="btn">Follow</button></form>
      <div class="questions"><div>What changed?</div><div>Why does it matter to me?</div><div>What can I try?</div><div>Did it improve my work?</div></div>
    </section>
    <h2 class="section-title">Featured</h2>
    <p class="muted small">Featured examples, not a popularity ranking. Status shows what has actually been researched on this computer.</p>
    <div class="grid">${featured.map(card).join("")}</div>
    ${others.length ? `<h2 class="section-title">Also followed</h2><div class="grid">${others.map(card).join("")}</div>` : ""}`;
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById("q").value.trim();
    if (!name) return;
    const known = persons.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (known) return (location.hash = `#/p/${known.id}`);
    const r = await post("/api/persons", { name });
    location.hash = `#/p/${r.id}`;
  };
}

// ---------------------------------------------------------------- Person
const TABS = [
  ["overview", "Overview"], ["changes", "What changed"], ["profile", "Profile"], ["work", "Put this to work"],
  ["results", "Did it help?"], ["desktop", "Desktop"], ["brain", "Evidence search"],
];

async function person(id, tab) {
  let d;
  try {
    d = await api(`/api/persons/${id}`);
  } catch (e) {
    $app.innerHTML = `<div class="pad"><div class="banner err">${esc(e.message)}</div><a href="#/">Back</a></div>`;
    return;
  }
  const p = d.person;
  $app.innerHTML = `
    <div class="phead">
      <div><a href="#/" class="small">← All people</a><h1>${esc(p.name)}</h1>
      <div class="muted small">${esc(p.description || "")}</div></div>
      <div style="text-align:right"><div class="chip plain">${esc(RESEARCH_LABEL[p.research_status] || p.research_status)}</div>
      <div class="small muted" style="margin-top:6px">Identity: ${esc(p.identity_status)}${p.wikidata_id ? ` · <a href="https://www.wikidata.org/wiki/${esc(p.wikidata_id)}" target="_blank" rel="noopener">${esc(p.wikidata_id)}</a>` : ""}</div></div>
    </div>
    <nav class="tabs">${TABS.map(([k, l]) => `<a href="#/p/${esc(id)}/${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>
    <div id="tab"></div>`;
  const el = document.getElementById("tab");
  const render = { overview, changes, profileTab, work, results, desktop, brain }[tab === "profile" ? "profileTab" : tab] || overview;
  await render(el, d, id);
  if (["resolving", "researching"].includes(p.research_status) && tab === "overview") timer = setInterval(() => route(), 5000);
}

async function overview(el, d, id) {
  const p = d.person;
  const goals = STATUS?.goals || {};
  const started = p.research_status !== "not_started";
  const totalJobs = d.jobs.reduce((a, j) => a + j.n, 0);
  const doneJobs = d.jobs.filter((j) => ["succeeded", "cancelled"].includes(j.status)).reduce((a, j) => a + j.n, 0);
  const counts = Object.fromEntries(d.analysis.map((a) => [a.analysis_status, a.n]));
  el.innerHTML = `
    ${p.identity_status === "ambiguous" ? `<div class="banner warn">Several people match this name. Choose the right one before any material is collected:
      <div style="margin-top:8px">${d.candidates.map((c) => `<button class="btn small ghost" data-qid="${esc(c.wikidata_id)}">${esc(c.label)} — ${esc(c.description || c.wikidata_id)}</button>`).join(" ")}</div></div>` : ""}
    ${!started ? `<div class="panel"><h3>Not researched yet</h3><p class="muted">Nothing has been collected for ${esc(p.name)} on this computer. Starting research resolves the identity first, then discovers and collects public sources.</p><button class="btn" id="go">Start research</button></div>` : ""}
    <div class="cols">
      <div class="panel"><h3>Your goal</h3>
        <form id="gf"><div class="goals">${Object.entries(goals).map(([k, l]) => `<label><input type="radio" name="goal" value="${k}" ${d.follow?.goal === k ? "checked" : ""}>${esc(l)}</label>`).join("")}</div>
        <input id="gnote" placeholder="Optional: what are you working on?" value="${esc(d.follow?.goal_note || "")}" style="width:100%;margin-top:10px;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--panel)">
        <button class="btn small" style="margin-top:10px">${d.follow ? "Update goal" : "Follow with this goal"}</button></form>
      </div>
      <div class="panel"><h3>Research progress</h3>
        ${totalJobs ? `<div class="bar"><i style="width:${Math.round((doneJobs / totalJobs) * 100)}%"></i></div><p class="small muted">${doneJobs}/${totalJobs} jobs done · analysis: ${counts.done || 0} analyzed, ${counts.pending || 0} pending, ${counts.skipped || 0} not analyzed (reporting, metadata-only, historical), ${counts.unavailable || 0} awaiting a model, ${counts.failed || 0} failed</p>` : `<p class="muted small">No jobs yet.</p>`}
        <details><summary>Activity log</summary><div class="small">${d.log.map((l) => `<div><span class="muted mono">${esc(fmt(l.created_at))}</span> ${l.level !== "info" ? `<b>${esc(l.level)}</b> ` : ""}${esc(l.message)}</div>`).join("") || "—"}</div></details>
      </div>
    </div>
    <div class="panel"><h3>Identity evidence</h3>
      ${d.identities.length ? `<div class="tablewrap"><table><tr><th>Kind</th><th>Value</th><th>Status</th><th>Evidence</th></tr>${d.identities.filter((i) => !["alias", "position"].includes(i.kind)).map((i) => `<tr><td>${esc(i.kind)}</td><td class="mono">${esc(i.value)}</td><td>${i.verified ? "Independently confirmed" : "Asserted (single source)"}</td><td class="small muted">${esc(i.evidence?.independent_confirmation || i.evidence?.method || i.evidence?.asserted_by || "")}</td></tr>`).join("")}</table></div>` : `<p class="muted small">Identity not resolved yet.</p>`}
    </div>
    <div class="panel"><h3>Source coverage</h3>
      ${d.sources.length ? `<div class="tablewrap"><table><tr><th>Source</th><th>Status</th><th>Items</th><th>Last successful collection</th><th>Capabilities</th><th>Gaps / errors</th></tr>
      ${d.sources.map((s) => `<tr><td>${esc(s.label)}<div class="small muted">${esc(s.adapter)} · ${esc(s.mode)}${s.auth_required ? ` · needs ${esc(s.auth_required)}` : ""}</div></td>
        <td>${chip(s.display_status)}</td><td>${s.item_count}</td><td class="small">${esc(s.last_success_at ? `${fmt(s.last_success_at)} (${ago(s.last_success_at)})` : "never")}${s.next_poll_at && s.mode !== "historical" ? `<div class="muted">next ${esc(ago(s.next_poll_at).replace(" ago", "") === "just now" ? "now" : fmt(s.next_poll_at))}</div>` : ""}</td>
        <td class="small muted">${esc(s.capabilities.realtime)} · ${esc(s.capabilities.content.replace("_", " "))}${s.capabilities.edits ? " · edits" : ""}${s.capabilities.deletions ? " · deletions" : ""}</td>
        <td class="small">${s.last_error ? `<div style="color:var(--fail)">${esc(s.last_error.slice(0, 160))}</div>` : ""}<span class="muted">${esc(s.coverage_gaps.join(" · "))}</span></td></tr>`).join("")}</table></div>
      <p class="small muted">“Live” is shown only for an active streaming connection with a heartbeat in the last 30 s. Polling sources are checked on a schedule; “Delayed” means the last success is older than three polling intervals.</p>` : `<p class="muted small">No sources discovered yet.</p>`}
    </div>`;
  el.querySelectorAll("[data-qid]").forEach((b) => (b.onclick = async () => { await post(`/api/persons/${id}/clarify`, { qid: b.dataset.qid }); route(); }));
  const go = document.getElementById("go");
  if (go) go.onclick = async () => { go.disabled = true; await post(`/api/persons/${id}/research`); route(); };
  document.getElementById("gf").onsubmit = async (e) => {
    e.preventDefault();
    const goal = el.querySelector("input[name=goal]:checked")?.value;
    if (!goal) return alert("Choose a goal");
    await post(`/api/persons/${id}/follow`, { goal, note: document.getElementById("gnote").value || null });
    route();
  };
}

function times(e) {
  return `<div class="times">
    <div>Statement/event<b>${esc(e.occurred_at ? fmt(e.occurred_at) : "unknown")}</b></div>
    <div>Published<b>${esc(e.published_at ? fmt(e.published_at) : "unknown")}</b></div>
    <div>Discovered<b>${esc(fmt(e.discovered_at))}</b></div>
    <div>Fetched<b>${esc(e.fetched_at ? fmt(e.fetched_at) : "unknown")}</b></div>
    <div>Analyzed<b>${esc(e.analyzed_at ? fmt(e.analyzed_at) : "not yet")}</b></div>
    <div>You received<b>${esc(e.delivered_at ? fmt(e.delivered_at) : "on first view")}</b></div></div>`;
}

async function changes(el, d, id) {
  const t = await api(`/api/persons/${id}/timeline`);
  const events = t.changes;
  el.innerHTML = `
    <p class="muted small">Detected changes, newest statement first. Each shows the direct evidence, then the app's interpretation. Reporting about ${esc(d.person.name)}, reposts and metadata-only items are listed separately and never counted as their statements.</p>
    ${events.length ? events.map((e) => `<div class="event ${e.stale ? "stale" : ""}">
      <div class="cls">${esc(CLS_LABEL[e.classification] || e.classification)} ${e.stale ? `· <span style="color:var(--fail)">stale: ${esc(e.stale_reason)}</span>` : ""}</div>
      <div style="font-weight:600;margin:2px 0">${esc(e.topic || "")}</div>
      <div class="layer">Direct evidence</div>
      ${e.quote ? `<blockquote>“${esc(e.quote)}”</blockquote>` : ""}
      <div class="small">${esc(e.source_label)} · ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title || e.url)}</a>` : esc(e.title || "")} · ${esc(e.attribution)} · ${esc(e.extraction)}</div>
      <div class="layer">Interpretation (app-generated)</div>
      <div class="small">${esc(e.summary)}</div>
      <div class="small muted">${esc(e.interpretation || "")}</div>
      <details><summary>Why this ranks here</summary><div class="small muted">${esc(e.rank_explanation)}</div></details>
      ${times(e)}
    </div>`).join("") : `<div class="empty">${d.person.research_status === "not_started" ? "Not researched yet." : "No analyzed changes yet. Items may still be queued for analysis, or none contained a substantive statement by this person."}</div>`}
    <h2 class="section-title" style="font-size:24px">Everything collected</h2>
    <div class="tablewrap"><table><tr><th>Item</th><th>Attribution</th><th>Published</th><th>Discovered</th><th>Analysis</th></tr>
    ${t.items.map((i) => `<tr><td>${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc((i.title || i.url).slice(0, 90))}</a>` : esc(i.title || "")}<div class="small muted">${esc(i.source_label)} · ${esc(i.relation)} · ${esc(i.extraction)}${i.current_version > 1 ? ` · v${i.current_version} (edited)` : ""}${i.is_historical ? " · historical" : ""}${i.deleted_at ? " · <b>deleted</b>" : ""}${i.injection_flag ? " · contained text aimed at AI (ignored)" : ""}</div></td>
      <td class="small">${esc(i.attribution)}</td><td class="small">${esc(day(i.published_at))}</td><td class="small">${esc(ago(i.discovered_at))}</td>
      <td class="small">${esc(i.analysis_status)}${i.analysis_note ? `<div class="muted">${esc(i.analysis_note.slice(0, 120))}</div>` : ""}</td></tr>`).join("")}</table></div>`;
}

async function profileTab(el, d, id) {
  const pr = await api(`/api/persons/${id}/profile`);
  el.innerHTML = `
    <p class="muted small">Positions and methods documented in public evidence, with dates. Provisional = limited evidence; durable = supported by at least two independent items on different days. No personality scores, no invented rule counts.</p>
    <h2 class="section-title" style="font-size:26px">Methods (conditional rules)</h2>
    ${pr.rules.length ? pr.rules.map((r) => `<div class="panel"><h3>${esc(r.data.principle)}</h3>
      <div class="small muted">${esc(r.status)} · ${esc(r.attribution === "stated" ? "explicitly stated" : r.attribution === "inferred" ? "inferred from actions" : "adapted")} · evidence ${esc(r.data.evidence_strength)} — ${esc(r.data.evidence_strength_explanation)} · applies from ${esc(day(r.data.applicable_period?.from))}</div>
      <div class="kgrid" style="margin-top:10px">
        <div><div class="k">Use when</div>${esc(r.data.activation_conditions.join("; "))}</div>
        <div><div class="k">Needs</div>${esc(r.data.required_information.join("; ") || "—")}</div>
        <div><div class="k">Procedure</div><ol class="steps">${r.data.procedure.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>
        <div><div class="k">Criteria & tradeoffs</div>${esc([...r.data.decision_criteria, ...r.data.tradeoffs].join("; ") || "—")}</div>
        <div><div class="k">Stop / exceptions</div>${esc(r.data.exceptions_and_stop_conditions.join("; ") || "—")}</div>
        <div><div class="k">Use / don't use</div>${esc(r.data.example_use)}<br><span class="muted">${esc(r.data.example_non_use)}</span></div>
      </div>
      <div class="small" style="margin-top:8px">Evidence: ${r.evidence.map((e) => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.locator)} (${esc(day(e.published_at))})</a>`).join(" · ")}</div></div>`).join("") : `<div class="empty">No methods extracted yet.</div>`}
    <h2 class="section-title" style="font-size:26px">Positions and their history</h2>
    ${pr.claims.length ? pr.claims.map((c) => `<div class="panel"><h3>${esc(c.topic)} <span class="chip plain">${esc(c.kind)} · ${esc(c.status)} · v${c.version}</span></h3>
      <div>${esc(c.statement)}</div>
      <div class="small muted">Evidence from ${esc(day(c.first_evidence_at))} to ${esc(day(c.last_evidence_at))}</div>
      ${c.evidence.map((e) => `<blockquote>“${esc(e.quote)}” <span class="small muted">— ${esc(e.relation)} · ${esc(e.locator)} · ${esc(day(e.occurred_at || e.published_at))}${e.deleted_at ? " · deleted" : ""} · <a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">source</a></span></blockquote>`).join("")}
      ${c.history.length > 1 ? `<details><summary>Version history</summary>${c.history.map((h) => `<div class="small">v${h.version} (${esc(h.status)}, ${esc(day(h.recorded_at))}): ${esc(h.statement)}</div>`).join("")}</details>` : ""}</div>`).join("") : `<div class="empty">No positions recorded yet.</div>`}
    ${pr.cases.length ? `<h2 class="section-title" style="font-size:26px">Documented decisions</h2>${pr.cases.map((c) => `<div class="panel small">
      <b>${esc(c.data.situation)}</b><div>Action: ${esc(c.data.action)}</div><div class="muted">Reasoning: ${esc(c.data.stated_reasoning || "not stated")} · Tradeoffs: ${esc(c.data.tradeoffs || "not stated")}</div>
      <div>Outcome: ${esc(c.data.outcome || "not reported")} <span class="chip plain">${esc(c.data.outcome_type)}</span></div></div>`).join("")}` : ""}`;
}

async function work(el, d, id) {
  if (!d.follow) {
    el.innerHTML = `<div class="empty">Choose a goal on the Overview tab to get cards tailored to it.</div>`;
    return;
  }
  const cards = await api(`/api/cards?person=${id}`);
  el.innerHTML = `
    <div class="statusbar" style="margin-bottom:14px"><span class="muted small">Goal: <b>${esc(STATUS?.goals?.[d.follow.goal] || d.follow.goal)}</b></span>
      <button class="btn small ghost" id="gen">Generate cards from new changes</button><span id="genmsg" class="small muted"></span></div>
    ${STATUS?.llm?.provider === "none" ? `<div class="banner warn">No analysis model configured, so no cards can be written. Set ANTHROPIC_API_KEY or HM_LLM_PROVIDER=claude-cli in ~/.human-machine/.env.</div>` : ""}
    ${cards.length ? cards.map((c) => kcard(c)).join("") : `<div class="empty">No cards yet. Cards appear after changes are analyzed and judged relevant to your goal.</div>`}`;
  document.getElementById("gen").onclick = async (ev) => {
    ev.target.disabled = true;
    document.getElementById("genmsg").textContent = "Working…";
    try {
      const r = await post(`/api/persons/${id}/cards`);
      document.getElementById("genmsg").textContent = `${r.created} new card(s)${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`;
      setTimeout(route, 800);
    } catch (e) { document.getElementById("genmsg").textContent = e.message; ev.target.disabled = false; }
  };
  el.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => {
    const k = b.closest(".kcard");
    k.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.mode));
    k.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("ghost", x !== b));
  }));
  el.querySelectorAll("[data-status]").forEach((b) => (b.onclick = async () => {
    const note = b.dataset.status === "tried" ? null : prompt("Optional note (what happened?)") || null;
    await post(`/api/cards/${b.dataset.card}/status`, { status: b.dataset.status, note });
    route();
  }));
}

function kcard(c) {
  const k = c.data;
  const e = k.evidence || {};
  return `<article class="kcard">
    ${k.stale ? `<div class="banner err">Stale: ${esc(k.stale)}</div>` : ""}
    <div class="small muted">${esc(CLS_LABEL[e.classification] || "")} · status <b>${esc(c.status)}</b></div>
    <h2>${esc(k.what_changed)}</h2>
    <div class="layer">Evidence</div>
    ${e.quote ? `<blockquote>“${esc(e.quote)}”</blockquote>` : ""}
    <div class="small">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title || e.url)}</a>` : ""} · statement ${esc(day(e.occurred_at || e.published_at))} · discovered ${esc(fmt(e.discovered_at))} · analyzed ${esc(fmt(e.analyzed_at))} · delivered ${esc(fmt(c.delivered_at))}</div>
    ${k.gbrain_support ? `<div class="small muted">Supporting context retrieved via GBrain at ${esc(fmt(k.gbrain_support.retrieved_at))}: ${k.gbrain_support.error ? `<span style="color:var(--fail)">retrieval failed (${esc(k.gbrain_support.error)})</span>` : k.gbrain_support.hits.map((h) => `<span class="mono">${esc(h.slug)}</span>`).join(", ") || "no related pages"}</div>` : ""}
    <div class="kgrid" style="margin-top:12px">
      <div><div class="k">Why it matters to you</div>${esc(k.why_it_matters)}</div>
      <div><div class="k">Try it</div>${esc(k.try_it)}</div>
      <div><div class="k">Success looks like</div>${esc(k.success_criterion)}</div>
      <div><div class="k">Limits</div>${esc(k.limits)}</div>
    </div>
    ${k.market_policy ? `<div class="panel small" style="margin-top:12px"><b>Type: ${esc(k.market_policy.statement_type.replace("_", " "))}</b><div>Implications: ${esc(k.market_policy.implications.join("; "))}</div><div>Scenarios: ${esc(k.market_policy.scenarios.join("; "))}</div><div class="muted">Not investment advice; no return predictions.</div></div>` : ""}
    <div class="mode"><button class="btn small" data-mode="learn">Learn with me</button><button class="btn small ghost" data-mode="agent">Improve my agent</button></div>
    <div data-pane="learn"><ol class="steps">${k.learn_with_me.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>
    <div data-pane="agent" hidden><div class="small muted">Proposed workflow/skill change — evaluate before adopting:</div><ol class="steps">${k.improve_my_agent.procedure.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div class="small">Evaluation: ${esc(k.improve_my_agent.evaluation)}</div></div>
    <div class="statusbar"><span class="small muted">Record result:</span>${["tried", "supported", "inconclusive", "rejected"].map((s) => `<button class="btn small ghost" data-status="${s}" data-card="${esc(c.id)}">${s}</button>`).join("")}
      <span class="small muted">Rank ${esc(k.rank?.score)} · goal relevance ${esc(k.rank?.goal_relevance)}</span></div>
  </article>`;
}

async function results(el, d, id) {
  const ex = (await api("/api/experiments")).filter((x) => x.title.endsWith(id));
  const row = (arm, s) => s ? `<tr><td>${esc(arm)}</td><td>${s.n}</td><td><b>${s.mean_score_of_6}</b></td>${Object.values(s.per_check).map((v) => `<td>${v}</td>`).join("")}<td>$${s.cost_usd}</td><td>${(s.total_ms / 1000).toFixed(1)} s</td></tr>` : "";
  const head = `<tr><th>Arm</th><th>n</th><th>Checks /6</th><th>Decision</th><th>Numbers</th><th>Negatives</th><th>No invented #</th><th>Stop rule</th><th>Length</th><th>Cost</th><th>Time</th></tr>`;
  el.innerHTML = `
    <p class="muted small">Workflow experiments compare your existing workflow (A), the same with fresh source context (B), and with context plus the proposed method (C). Same model, prompt and token budget. Deterministic checks, fixed before running. Results are reported separately — there is no single “intelligence score”.</p>
    <p class="small">Run one with <span class="mono">bun run hm eval ${esc(id)}</span> (uses your configured model; about 30 calls).</p>
    ${ex.length ? ex.map((x) => `<div class="panel"><h3>${esc(x.title)} — ${esc(x.status)}${x.decision ? ` · decision: <b>${esc(x.decision)}</b>` : ""}</h3>
      <div class="small muted">${esc(fmt(x.created_at))} · ${esc(x.design.decision_rule)}</div>
      ${x.results?.error ? `<div class="banner err">${esc(x.results.error)}</div>` : ""}
      ${x.results?.validation ? `<div class="tablewrap"><div class="layer">Validation</div><table>${head}${row("A existing", x.results.validation.A)}${row("B + context", x.results.validation.B)}${row(`C + context + method v${x.results.chosen_version}`, x.results.validation.C_best)}</table>
        <div class="layer">Test (locked, run once after the decision)</div><table>${head}${row("A", x.results.test.A)}${row("B", x.results.test.B)}${row("C", x.results.test.C)}</table>
        <div class="layer">Development</div><table>${head}${row("A", x.results.dev.A)}${row("B", x.results.dev.B)}${row("C", x.results.dev.C)}</table></div>
        <details><summary>Method versions (improvement loop)</summary>${x.results.method_versions.map((v) => `<div class="small" style="margin:6px 0"><b>v${v.v}</b>${v.parent !== null ? ` (from v${v.parent})` : ""}: ${esc(v.decision || "")} · validation ${v.validation?.mean_score_of_6 ?? "—"} · failing on dev: ${esc(v.failing.join(", ") || "none")}<ol class="steps">${v.method.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>`).join("")}</details>
        <div class="small muted">Not measured: ${esc(x.results.not_measured.join("; "))}. Caveat: ${esc(x.design.caveat)}</div>` : ""}
    </div>`).join("") : `<div class="empty">No experiments yet.</div>`}`;
}

async function desktop(el, d, id) {
  const versions = await api(`/api/persons/${id}/skill`).catch(() => []);
  el.innerHTML = `
    <div class="panel"><h3>1 · Read-only agent token</h3>
      <p class="small muted">Desktop agents read your current context through a local, authenticated, read-only API. The token is stored hashed; it is shown once.</p>
      <p class="small">Recommended: <span class="mono">bun run hm agent-token</span> (writes ~/.human-machine/agent-token, mode 600).</p></div>
    <div class="panel"><h3>2 · Skill package (Agent Skills format)</h3>
      <button class="btn small" id="exp">Export new version</button> <span id="expmsg" class="small muted"></span>
      ${versions.length ? `<div class="tablewrap" style="margin-top:10px"><table><tr><th>Version</th><th>Status</th><th>Created</th><th>Path</th><th></th></tr>${versions.map((v) => `<tr><td>v${v.version}</td><td>${esc(v.status)}<div class="small muted">${esc(v.reason || "")}</div></td><td class="small">${esc(fmt(v.created_at))}</td><td class="mono small">${esc(v.manifest.path)}</td><td><button class="btn small ghost" data-rb="${esc(v.id)}">Make current</button></td></tr>`).join("")}</table></div>` : `<p class="small muted">No versions yet.</p>`}
      <p class="small">Install for Claude Code: <span class="mono">bun run hm export-skill ${esc(id)} --install user</span></p>
      <p class="small muted">The skill contains a snapshot plus <span class="mono">scripts/hm_context.sh</span>, which fetches dated context from this app and prints its refresh time. If the app is unreachable it prints the last cached context labelled STALE.</p></div>
    <div class="panel"><h3>3 · Or connect over MCP</h3><pre>claude mcp add human-machine -- bun run /path/to/human-machine/src/cli.ts mcp</pre>
      <p class="small muted">Tools: hm_get_context, hm_changes_since, hm_get_evidence, hm_list_people (read-only).</p></div>
    <div class="panel"><h3>Clients</h3><p class="small">Claude Code (macOS): tested. Other Agent Skills / MCP clients and other operating systems: untested — see TESTING.md.</p></div>`;
  document.getElementById("exp").onclick = async () => {
    try {
      const r = await post(`/api/persons/${id}/skill`);
      document.getElementById("expmsg").textContent = `v${r.version}${r.unchanged ? " (no changes since last version)" : ""}`;
      setTimeout(route, 600);
    } catch (e) { document.getElementById("expmsg").textContent = e.message; }
  };
  el.querySelectorAll("[data-rb]").forEach((b) => (b.onclick = async () => { await post(`/api/skills/${b.dataset.rb}/rollback`); route(); }));
}

async function brain(el, d, id) {
  el.innerHTML = `<p class="muted small">Search the public-evidence GBrain for ${esc(d.person.name)}. Results come from GBrain and are mapped back to original sources.</p>
    <form class="search" id="bf" style="margin:0 0 16px;max-width:none"><input id="bq" placeholder="e.g. evaluation, founders, AI agents"><button class="btn">Search GBrain</button></form><div id="bres"></div>`;
  document.getElementById("bf").onsubmit = async (e) => {
    e.preventDefault();
    const out = document.getElementById("bres");
    out.innerHTML = `<p class="muted small">Searching…</p>`;
    try {
      const r = await api(`/api/persons/${id}/brain?q=${encodeURIComponent(document.getElementById("bq").value)}`);
      out.innerHTML = r.hits.length ? r.hits.map((h) => `<div class="panel"><div class="mono small">${esc(h.slug)} · score ${Number(h.score).toFixed(3)}</div><div class="small">${esc(String(h.chunk_text).slice(0, 500))}</div>
        <div class="small muted">${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">original source</a> · ` : ""}${esc(h.attribution || "")} · published ${esc(day(h.publishedAt))}</div></div>`).join("") : `<div class="empty">No matching pages in GBrain.</div>`;
    } catch (err) { out.innerHTML = `<div class="banner err">GBrain query failed: ${esc(err.message)}</div>`; }
  };
}

loadStatus();
setInterval(loadStatus, 15000);
route();
