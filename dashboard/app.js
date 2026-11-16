/* Stellenradar – Supabase-Version */
(() => {
  const SUPABASE_URL = "https://ckyyzxkcvvoekagrwxvx.supabase.co";
  const SUPABASE_KEY = "sb_publishable_-YbwP6jR5vWHXWsLyN_KHA_TWHghWnD";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const STATUSES = [
    { id: "offen", label: "Offen" },
    { id: "in_arbeit", label: "In Arbeit" },
    { id: "beworben", label: "Beworben" },
    { id: "interview", label: "Interview" },
    { id: "zusage", label: "Zusage" },
    { id: "absage", label: "Absage" },
  ];
  const ST = Object.fromEntries(STATUSES.map(s => [s.id, s]));
  const PORTALS = ["jobs.ch", "jobup.ch", "jobscout24.ch", "LinkedIn", "Indeed", "job-room.ch (RAV)", "Glassdoor", "Firmenwebseiten"];

  /* camelCase (Seite) <-> snake_case (Datenbank) */
  const MAP = { postedAt: "posted_at", matchReason: "match_reason", startDate: "start_date", notesAt: "notes_at", appliedAt: "applied_at", foundAt: "found_at", updatedAt: "updated_at" };
  const RMAP = Object.fromEntries(Object.entries(MAP).map(([a, b]) => [b, a]));
  const DATE_COLS = new Set(["deadline", "applied_at"]);
  const fromRow = r => { const o = {}; for (const k in r) o[RMAP[k] || k] = r[k]; return o; };
  const toRow = p => { const o = {}; for (const k in p) { const c = MAP[k] || k; let v = p[k]; if (DATE_COLS.has(c) && !v) v = null; o[c] = v; } return o; };

  const state = { view: "neu", jobs: new Map(), profile: null, loaded: false, error: null, q: "", sort: "score", openId: null, confirmPurge: false, user: null };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nowIso = () => new Date().toISOString();
  const fmtDate = iso => { if (!iso) return ""; const d = new Date(iso); if (isNaN(d)) return esc(iso); return d.toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" }); };
  const fmtShort = iso => { if (!iso) return ""; const d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" }); };
  const relDays = iso => {
    if (!iso) return ""; const d = new Date(iso); if (isNaN(d)) return "";
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return "heute"; if (days === 1) return "gestern"; if (days < 30) return `vor ${days} Tagen`; return fmtDate(iso);
  };
  const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };
  const list = v => Array.isArray(v) ? v.filter(Boolean) : (v ? String(v).split(/\n|;/).map(s => s.trim()).filter(Boolean) : []);

  /* ---------- Schreiben: eine Änderung pro Stelle nach der anderen ---------- */
  const chains = new Map();
  function write(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => { const { error } = await fn(); if (error) throw error; })
      .catch(e => { console.error(e); toast("Speichern fehlgeschlagen. Prüfe die Internetverbindung und versuch es nochmals."); throw e; });
    chains.set(key, next);
    return next;
  }
  function updateJob(id, patch, log) {
    const cur = state.jobs.get(id); if (!cur) return Promise.resolve();
    const merged = { ...cur, ...patch, updatedAt: nowIso() };
    if (log) merged.history = [...(cur.history || []), { at: nowIso(), text: log }].slice(-40);
    state.jobs.set(id, merged);
    render();
    const body = { ...patch, updatedAt: merged.updatedAt };
    if (log) body.history = merged.history;
    return write(id, () => sb.from("jobs").update(toRow(body)).eq("id", id));
  }
  function purge(id) {
    state.jobs.delete(id);
    write(id, () => sb.from("jobs").delete().eq("id", id));
  }

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(msg, action) {
    const host = $("#toastHost");
    host.innerHTML = `<div class="toast" role="status"><span>${esc(msg)}</span>${action ? `<button type="button" id="toastAct">${esc(action.label)}</button>` : ""}</div>`;
    if (action) $("#toastAct").onclick = () => { host.innerHTML = ""; action.run(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => host.innerHTML = "", action ? 6000 : 3200);
  }

  /* ---------- Abgeleitete Listen ---------- */
  const inbox = () => [...state.jobs.values()].filter(j => (j.stage || "neu") === "neu");
  const pipeline = () => [...state.jobs.values()].filter(j => j.stage === "pipeline");
  const trash = () => [...state.jobs.values()].filter(j => j.stage === "verworfen");
  function matchQ(j) {
    if (!state.q) return true;
    const hay = [j.title, j.company, j.location, j.summary, j.source].join(" ").toLowerCase();
    return state.q.toLowerCase().split(/\s+/).every(t => hay.includes(t));
  }
  function sorted(arr) {
    const by = state.sort;
    return arr.slice().sort((a, b) => {
      if (by === "score") return (b.score ?? 0) - (a.score ?? 0);
      if (by === "new") return String(b.foundAt || "").localeCompare(String(a.foundAt || ""));
      if (by === "deadline") return String(a.deadline || "9999").localeCompare(String(b.deadline || "9999"));
      return 0;
    });
  }

  /* ---------- Darstellung ---------- */
  function scoreRing(n) {
    if (n == null || isNaN(n)) return "";
    const v = Math.max(0, Math.min(100, Math.round(n)));
    const r = 22, c = 2 * Math.PI * r, off = c * (1 - v / 100);
    const col = v >= 80 ? "var(--good)" : v >= 60 ? "var(--warn)" : "var(--muted)";
    return `<div class="score" title="Passung zu deinem Suchprofil: ${v} von 100">
      <svg viewBox="0 0 54 54" aria-hidden="true"><circle cx="27" cy="27" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="5"/>
      <circle cx="27" cy="27" r="${r}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>
      <div class="val">${v}</div><div class="lbl">Match</div></div>`;
  }
  function facts(j) {
    const f = [];
    if (j.location) f.push(`<span class="fact"><svg><use href="#i-pin"/></svg>${esc(j.location)}</span>`);
    if (j.workload) f.push(`<span class="fact"><svg><use href="#i-clock"/></svg>${esc(j.workload)}</span>`);
    if (j.salary) f.push(`<span class="fact"><svg><use href="#i-chf"/></svg>${esc(j.salary)}</span>`);
    if (j.deadline) f.push(`<span class="fact"><svg><use href="#i-cal"/></svg>Frist ${fmtDate(j.deadline)}</span>`);
    return f.join("");
  }
  function jobCard(j) {
    const url = safeUrl(j.url);
    const hl = list(j.highlights), req = list(j.requirements);
    const hasMore = hl.length || req.length || j.contact || j.startDate;
    return `<article class="job" data-id="${esc(j.id)}">
      <div class="job-top">
        <div style="min-width:0"><h3>${esc(j.title || "Ohne Titel")}</h3><div class="company">${esc(j.company || "Unbekannte Firma")}</div></div>
        ${scoreRing(j.score)}
      </div>
      <div class="facts">${facts(j)}</div>
      ${j.summary ? `<p class="summary">${esc(j.summary)}</p>` : ""}
      ${j.matchReason ? `<div class="why"><b>Warum es passt:</b> ${esc(j.matchReason)}</div>` : ""}
      ${hasMore ? `<details class="more"><summary>Alle Details</summary>
        ${hl.length ? `<h4>Aufgaben</h4><ul>${hl.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${req.length ? `<h4>Anforderungen</h4><ul>${req.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${j.startDate ? `<h4>Stellenantritt</h4><div>${esc(j.startDate)}</div>` : ""}
        ${j.contact ? `<h4>Kontakt</h4><div>${esc(j.contact)}</div>` : ""}
      </details>` : ""}
      <div class="job-meta">
        ${j.source ? `<span class="chip src">${esc(j.source)}</span>` : ""}
        <span class="when">gefunden ${relDays(j.foundAt)}</span>
      </div>
      <div class="job-actions">
        <button class="btn primary" data-act="keep" data-id="${esc(j.id)}"><svg><use href="#i-keep"/></svg>Behalten</button>
        <button class="btn" data-act="dismiss" data-id="${esc(j.id)}"><svg><use href="#i-x"/></svg>Verwerfen</button>
        ${url ? `<a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener" aria-label="Inserat öffnen" title="Inserat öffnen"><svg><use href="#i-ext"/></svg></a>` : `<span></span>`}
      </div>
    </article>`;
  }
  function errorBox() { return state.error ? `<div class="notice err">${esc(state.error)}</div>` : ""; }

  function viewInbox() {
    const items = sorted(inbox().filter(matchQ));
    const total = inbox().length;
    const last = state.profile && state.profile.lastScan;
    const head = `<div class="view-head">
      <div>
        <div class="eyebrow">${last ? `Letzter Suchlauf ${fmtShort(last)}` : "Noch kein Suchlauf"}</div>
        <h1>${total ? `${total} neue ${total === 1 ? "Stelle" : "Stellen"} für dich` : "Neue Treffer"}</h1>
        <p>Der Suchlauf prüft jeden Morgen die Schweizer Jobportale nach deinem Suchprofil. Behalte, was dich interessiert, den Rest verwirfst du.</p>
      </div>
      <div class="filters">
        <label class="search"><svg><use href="#i-search"/></svg><input id="q" type="search" placeholder="Titel, Firma, Ort…" value="${esc(state.q)}" aria-label="Treffer durchsuchen"></label>
        <select class="sort" id="sort" aria-label="Sortierung">
          <option value="score"${state.sort === "score" ? " selected" : ""}>Beste Passung</option>
          <option value="new"${state.sort === "new" ? " selected" : ""}>Neueste zuerst</option>
          <option value="deadline"${state.sort === "deadline" ? " selected" : ""}>Frist zuerst</option>
        </select>
      </div>
    </div>`;
    let body;
    if (!state.loaded && !state.error) body = `<div class="empty"><svg><use href="#i-radar"/></svg><h2>Lade deine Treffer…</h2></div>`;
    else if (!total) body = `<div class="empty"><svg><use href="#i-radar"/></svg><h2>Alles abgearbeitet</h2>
        <p>Neue Stellen, die zu deinem Suchprofil passen, landen hier mit Kurzbeschrieb, Pensum, Ort, Lohn und Link zum Inserat.</p>
        <button class="btn" data-go="profil">Suchprofil anpassen</button></div>`;
    else if (!items.length) body = `<div class="empty"><h2>Keine Treffer für «${esc(state.q)}»</h2><p>Probier einen anderen Suchbegriff.</p></div>`;
    else body = `<div class="feed">${items.map(jobCard).join("")}</div>`;
    const tr = trash();
    const trashHtml = tr.length ? `<details class="trash"><summary>Verworfen (${tr.length})</summary><ul>
      ${tr.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 100).map(j => `<li><span>${esc(j.title)} · ${esc(j.company || "")}</span><span style="display:flex;gap:4px;flex:none"><button class="btn ghost" data-act="restore" data-id="${esc(j.id)}">Zurückholen</button><button class="btn ghost danger" data-act="purge" data-id="${esc(j.id)}">Löschen</button></span></li>`).join("")}
    </ul>${state.confirmPurge
      ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px"><span>Alle ${tr.length} verworfenen Stellen endgültig löschen?</span><button class="btn primary" data-act2="purgeall">Ja, alle löschen</button><button class="btn ghost" data-act2="purgecancel">Abbrechen</button></div>`
      : `<button class="btn ghost danger" style="margin-top:12px" data-act2="purgeask">Alle endgültig löschen</button>`}</details>` : "";
    return errorBox() + head + body + trashHtml;
  }
  function dueInfo(j) {
    if (!j.deadline) return "";
    const d = new Date(j.deadline); if (isNaN(d)) return "";
    const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
    if (["beworben", "interview", "zusage", "absage"].includes(j.status)) return "";
    if (days < 0) return `<span class="due over">Frist vorbei</span>`;
    if (days <= 7) return `<span class="due">Frist in ${days} ${days === 1 ? "Tag" : "Tagen"}</span>`;
    return `<span>Frist ${fmtDate(j.deadline)}</span>`;
  }
  function mini(j) {
    const st = j.status || "offen";
    return `<button class="mini" data-open="${esc(j.id)}" data-st="${st}" draggable="true">
      <span class="t">${esc(j.title)}</span>
      <span class="c">${esc(j.company || "")}${j.location ? " · " + esc(j.location) : ""}</span>
      <span class="foot">${dueInfo(j)}${j.notes ? `<span class="note-ind"><svg><use href="#i-note"/></svg>Notiz</span>` : ""}</span>
    </button>`;
  }
  function viewPipeline() {
    const all = pipeline().filter(matchQ);
    const by = Object.fromEntries(STATUSES.map(s => [s.id, []]));
    all.forEach(j => (by[j.status] || by.offen).push(j));
    Object.values(by).forEach(a => a.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))));
    const total = pipeline().length;
    const head = `<div class="view-head">
      <div><div class="eyebrow">Pipeline</div><h1>Meine Bewerbungen</h1>
        <p>Tippe eine Stelle an, um Status, Notizen, Frist und Kontaktperson festzuhalten. Auf dem Laptop kannst du Karten auch zwischen den Spalten ziehen.</p></div>
      <div class="filters" style="flex-direction:column;align-items:stretch">
        <label class="search"><svg><use href="#i-search"/></svg><input id="q" type="search" placeholder="Suchen…" value="${esc(state.q)}" aria-label="Bewerbungen durchsuchen"></label>
      </div>
    </div>
    <div class="stats" style="margin-bottom:18px">${STATUSES.map(s => `<span class="stat" data-st="${s.id}"><span class="pill">${s.label}</span><b>${by[s.id].length}</b></span>`).join("")}</div>`;
    if (!total) return errorBox() + head + `<div class="empty"><svg><use href="#i-board"/></svg><h2>Noch keine Stelle behalten</h2>
        <p>Wenn dir unter «Neue Treffer» eine Stelle gefällt, tippe auf «Behalten». Sie erscheint dann hier, und du kannst den Bewerbungsstand verfolgen.</p>
        <button class="btn" data-go="neu">Zu den neuen Treffern</button></div>`;
    const board = `<div class="board-scroll"><div class="board">${STATUSES.map(s => `
      <section class="col" data-col="${s.id}" data-st="${s.id}" aria-label="${s.label}">
        <div class="col-head"><span class="dot" style="background:var(--st)"></span>${s.label}<span class="n">${by[s.id].length}</span></div>
        ${by[s.id].map(mini).join("")}
      </section>`).join("")}</div></div>`;
    const plist = `<div class="plist">${STATUSES.filter(s => by[s.id].length).map(s => `
      <div class="pgroup" data-st="${s.id}"><h3><span class="pill">${s.label}</span>${by[s.id].length}</h3><div style="display:grid;gap:8px">${by[s.id].map(mini).join("")}</div></div>`).join("")}</div>`;
    return errorBox() + head + board + plist;
  }
  function viewProfile() {
    const p = state.profile || {};
    const portals = Array.isArray(p.portals) && p.portals.length ? p.portals : PORTALS.slice(0, 6);
    return errorBox() + `<div class="view-head"><div><div class="eyebrow">Einstellungen</div><h1>Suchprofil</h1>
      <p>Danach richtet sich der automatische Suchlauf. Jede Änderung ist sofort auf allen deinen Geräten gespeichert.</p></div></div>
    <div class="profile">
      <form class="panel" id="pform" autocomplete="off">
        <h2>Was suchst du?</h2>
        <div class="field"><label for="p-roles">Berufe / Jobtitel</label>
          <input id="p-roles" name="roles" value="${esc(p.roles || "")}" placeholder="z. B. Mediamatiker, Grafiker"><span class="hint">Mehrere mit Komma trennen.</span></div>
        <div class="field"><label for="p-keywords">Stichworte, die vorkommen sollen</label>
          <input id="p-keywords" name="keywords" value="${esc(p.keywords || "")}" placeholder="z. B. Broschüren, WordPress"></div>
        <div class="two">
          <div class="field"><label for="p-locations">Orte / Regionen</label><input id="p-locations" name="locations" value="${esc(p.locations || "")}" placeholder="z. B. Region Sursee"></div>
          <div class="field"><label for="p-radius">Umkreis (km)</label><input id="p-radius" name="radius" type="number" min="0" step="5" value="${esc(p.radius ?? "")}" placeholder="25"></div>
        </div>
        <div class="two">
          <div class="field"><label for="p-workload">Pensum</label><input id="p-workload" name="workload" value="${esc(p.workload || "")}" placeholder="z. B. 80–100 %"></div>
          <div class="field"><label for="p-salary">Mindestlohn (CHF / Jahr)</label><input id="p-salary" name="minSalary" type="number" min="0" step="1000" value="${esc(p.minSalary ?? "")}" placeholder="60000"></div>
        </div>
        <div class="two">
          <div class="field"><label for="p-level">Stufe / Erfahrung</label>
            <select id="p-level" name="level">${["", "Lehrstelle", "Praktikum", "Berufseinstieg", "Fachkraft", "Senior", "Kader / Führung"].map(v => `<option value="${esc(v)}"${(p.level || "") === v ? " selected" : ""}>${v || "egal"}</option>`).join("")}</select></div>
          <div class="field"><label for="p-lang">Sprache der Stelle</label><input id="p-lang" name="languages" value="${esc(p.languages || "")}" placeholder="z. B. Deutsch"></div>
        </div>
        <div class="field"><label for="p-exclude">Ausschliessen</label><input id="p-exclude" name="exclude" value="${esc(p.exclude || "")}" placeholder="z. B. Temporär, Callcenter"></div>
        <div class="field"><label for="p-about">Über mich (hilft beim Match)</label><textarea id="p-about" name="about" placeholder="Ausbildung, Erfahrung, Stärken, was dir wichtig ist…">${esc(p.about || "")}</textarea></div>
        <div class="field"><span class="lab">Portale durchsuchen</span>
          <div class="portals">${PORTALS.map((x, i) => `<label for="pp-${i}"><input type="checkbox" id="pp-${i}" name="portals" value="${esc(x)}"${portals.includes(x) ? " checked" : ""}>${esc(x)}</label>`).join("")}</div></div>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="btn primary" type="submit">Suchprofil speichern</button>
          <span class="saved" id="psaved">${p.updatedAt ? "Zuletzt gespeichert " + fmtShort(p.updatedAt) : ""}</span>
        </div>
      </form>
      <aside class="panel">
        <h2>Suchlauf</h2>
        <div class="scanlog">
          <div><div class="eyebrow">Letzter Lauf</div><div class="big">${p.lastScan ? fmtShort(p.lastScan) : "noch keiner"}</div></div>
          ${p.lastScanNote ? `<div style="color:var(--muted)">${esc(p.lastScanNote)}</div>` : ""}
          <div><div class="eyebrow">Rhythmus</div><div>${esc(p.schedule || "täglich am Morgen")}</div></div>
        </div>
        <div class="howto"><div class="eyebrow" style="margin-bottom:6px">So funktioniert's</div>
          <ol><li>Ein geplanter Suchlauf liest dieses Suchprofil.</li><li>Er durchsucht die Jobportale nach neuen Inseraten.</li>
          <li>Passende Stellen landen mit Kurzbeschrieb und Match-Wert unter «Neue Treffer». Bereits gesehene oder verworfene Stellen kommen nicht nochmals.</li></ol></div>
        <div style="border-top:1px solid var(--line);padding-top:14px;display:grid;gap:8px">
          <div class="eyebrow">Angemeldet als</div><div style="overflow-wrap:anywhere">${esc(state.user?.email || "")}</div>
          <button class="btn" type="button" data-act2="logout">Abmelden</button>
        </div>
      </aside>
    </div>`;
  }

  function render() {
    const main = $("#main");
    if (!state.user) return;
    const active = document.activeElement;
    const focusId = active && active.id && main.contains(active) ? active.id : null;
    const selStart = focusId && active.selectionStart != null ? active.selectionStart : null;
    if (state.view === "profil" && main.dataset.view === "profil" && main.querySelector("#pform") && active && active.closest && active.closest("#pform")) { updateCounts(); return; }
    main.dataset.view = state.view;
    main.innerHTML = state.view === "neu" ? viewInbox() : state.view === "pipeline" ? viewPipeline() : viewProfile();
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (selStart != null && el.setSelectionRange) try { el.setSelectionRange(selStart, selStart); } catch {} } }
    updateCounts();
    if (state.openId) renderDrawer();
  }
  function updateCounts() {
    document.querySelectorAll("[data-count=neu]").forEach(el => { const n = inbox().length; el.textContent = n; el.classList.toggle("hot", n > 0); });
    document.querySelectorAll("[data-count=pipeline]").forEach(el => el.textContent = pipeline().length);
    document.querySelectorAll(".tab[data-view]").forEach(el => el.setAttribute("aria-selected", String(el.dataset.view === state.view)));
  }

  /* ---------- Detail-Ansicht ---------- */
  let noteTimer = null;
  function timeline(j) {
    const h = (j.history || []).slice().reverse();
    if (!h.length) return `<li><time>${fmtDate(j.foundAt)}</time><span>Gefunden${j.source ? " auf " + esc(j.source) : ""}</span></li>`;
    return h.map(e => `<li><time>${fmtDate(e.at)}</time><span>${esc(e.text)}</span></li>`).join("");
  }
  function renderDrawer() {
    const j = state.jobs.get(state.openId);
    const ov = $("#overlay");
    if (!j) { ov.innerHTML = ""; state.openId = null; return; }
    const st = j.status || "offen";
    const open = ov.querySelector(".drawer");
    if (open && open.dataset.id === j.id) {
      // Detail ist schon offen: nur Status, Verlauf und Kopf aktualisieren, Eingaben nicht überschreiben
      ov.querySelectorAll(".status-pick button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.st === st)));
      const head = ov.querySelector(".drawer-head [data-st]"); if (head) { head.dataset.st = st; head.innerHTML = `<span class="pill">${ST[st].label}</span>`; }
      const tl = $("#d-tl"); if (tl) tl.innerHTML = timeline(j);
      const ae = document.activeElement;
      const n = $("#d-notes"); if (n && ae !== n && !noteTimer && n.value !== (j.notes || "")) n.value = j.notes || "";
      const ap = $("#d-applied"); if (ap && ae !== ap) ap.value = (j.appliedAt || "").slice(0, 10);
      const dl = $("#d-deadline"); if (dl && ae !== dl) dl.value = (j.deadline || "").slice(0, 10);
      const ct = $("#d-contact"); if (ct && ae !== ct) ct.value = j.contact || "";
      return;
    }
    const url = safeUrl(j.url);
    ov.innerHTML = `<div class="scrim" data-close></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="d-title" data-id="${esc(j.id)}">
      <div class="drawer-head">
        <div style="flex:1;min-width:0">
          <div data-st="${st}"><span class="pill">${ST[st].label}</span></div>
          <h2 id="d-title" style="margin-top:8px">${esc(j.title)}</h2>
          <div class="company">${esc(j.company || "")}${j.location ? " · " + esc(j.location) : ""}</div>
        </div>
        <button class="btn ghost" data-close aria-label="Schliessen"><svg><use href="#i-x"/></svg></button>
      </div>
      <div class="drawer-body">
        <div class="field"><span class="lab">Status</span>
          <div class="status-pick">${STATUSES.map(s => `<button type="button" data-st="${s.id}" aria-pressed="${s.id === st}" data-setst="${s.id}">${s.label}</button>`).join("")}</div></div>
        <div class="field"><label for="d-notes">Bemerkungen</label>
          <textarea id="d-notes" placeholder="z. B. Motivationsschreiben angepasst, Gespräch am 3.12. um 14 Uhr…">${esc(j.notes || "")}</textarea>
          <span class="saved" id="d-saved">${j.notesAt ? "Gespeichert " + fmtShort(j.notesAt) : "Wird automatisch gespeichert."}</span></div>
        <div class="two">
          <div class="field"><label for="d-deadline">Bewerbungsfrist</label><input id="d-deadline" type="date" value="${esc((j.deadline || "").slice(0, 10))}"></div>
          <div class="field"><label for="d-applied">Beworben am</label><input id="d-applied" type="date" value="${esc((j.appliedAt || "").slice(0, 10))}"></div>
        </div>
        <div class="field"><label for="d-contact">Kontaktperson</label><input id="d-contact" value="${esc(j.contact || "")}" placeholder="Name, Telefon, E-Mail"></div>
        <dl class="kv">
          ${j.workload ? `<dt>Pensum</dt><dd>${esc(j.workload)}</dd>` : ""}
          ${j.salary ? `<dt>Lohn</dt><dd>${esc(j.salary)}</dd>` : ""}
          ${j.startDate ? `<dt>Antritt</dt><dd>${esc(j.startDate)}</dd>` : ""}
          ${j.source ? `<dt>Gefunden auf</dt><dd>${esc(j.source)} · ${fmtDate(j.foundAt)}</dd>` : ""}
          ${url ? `<dt>Inserat</dt><dd><a href="${esc(url)}" target="_blank" rel="noopener">Inserat öffnen ↗</a></dd>` : ""}
        </dl>
        ${j.summary ? `<div class="field"><span class="lab">Kurzbeschrieb</span><div>${esc(j.summary)}</div></div>` : ""}
        ${list(j.highlights).length ? `<div class="field"><span class="lab">Aufgaben</span><ul style="margin:0;padding-left:18px">${list(j.highlights).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${list(j.requirements).length ? `<div class="field"><span class="lab">Anforderungen</span><ul style="margin:0;padding-left:18px">${list(j.requirements).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        <div class="field"><span class="lab">Verlauf</span><ul class="timeline" id="d-tl">${timeline(j)}</ul></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" data-act="unkeep" data-id="${esc(j.id)}">Zurück zu den Treffern</button>
          <button class="btn ghost danger" data-act="remove" data-id="${esc(j.id)}">Stelle entfernen</button>
        </div>
      </div>
    </aside>`;
  }
  function openDrawer(id) { state.openId = id; renderDrawer(); setTimeout(() => { const b = $("#overlay .drawer [data-close]"); b && b.focus(); }, 30); }
  function closeDrawer() { flushNotes(); state.openId = null; $("#overlay").innerHTML = ""; }
  function flushNotes() { if (!noteTimer) return; clearTimeout(noteTimer.t); const { id, val } = noteTimer; noteTimer = null; saveNotes(id, val); }
  function saveNotes(id, val) {
    const j = state.jobs.get(id); if (!j || (j.notes || "") === val) return;
    updateJob(id, { notes: val, notesAt: nowIso() }).then(() => { const s = $("#d-saved"); if (s && state.openId === id) s.textContent = "Gespeichert " + fmtShort(nowIso()); }).catch(() => {});
  }

  /* ---------- Aktionen ---------- */
  function animateOut(id, then) {
    const el = document.querySelector(`.job[data-id="${CSS.escape(id)}"]`);
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return then();
    el.classList.add("leaving"); setTimeout(then, 260);
  }
  function setStatus(id, st) {
    const j = state.jobs.get(id); if (!j || (j.status || "offen") === st) return;
    const patch = { status: st };
    if (st === "beworben" && !j.appliedAt) patch.appliedAt = new Date().toISOString().slice(0, 10);
    updateJob(id, patch, `Status: ${ST[st].label}`);
  }
  const reopenTrash = () => { const d = document.querySelector(".trash"); if (d) d.open = true; };
  document.addEventListener("click", e => {
    const t2 = e.target.closest("[data-act2]");
    if (t2) {
      const a = t2.dataset.act2;
      if (a === "logout") { sb.auth.signOut(); return; }
      if (a === "purgeask") state.confirmPurge = true;
      if (a === "purgecancel") state.confirmPurge = false;
      if (a === "purgeall") { state.confirmPurge = false; const n = trash().length; trash().forEach(j => purge(j.id)); toast(`${n} Stellen endgültig gelöscht`); }
      render(); reopenTrash(); return;
    }
    const t = e.target.closest("[data-act],[data-go],[data-open],[data-close],[data-setst],.tab[data-view]");
    if (!t) return;
    if (t.matches(".tab[data-view]")) return go(t.dataset.view);
    if (t.dataset.go) return go(t.dataset.go);
    if (t.hasAttribute("data-close")) return closeDrawer();
    if (t.dataset.open) return openDrawer(t.dataset.open);
    if (t.dataset.setst) return setStatus(state.openId, t.dataset.setst);
    const id = t.dataset.id, act = t.dataset.act;
    const j = state.jobs.get(id); if (!j) return;
    if (act === "keep") animateOut(id, () => { updateJob(id, { stage: "pipeline", status: j.status || "offen" }, "Behalten"); toast("In «Meine Bewerbungen» verschoben", { label: "Öffnen", run: () => { go("pipeline"); openDrawer(id); } }); });
    if (act === "dismiss") animateOut(id, () => { updateJob(id, { stage: "verworfen" }, "Verworfen"); toast("Stelle verworfen", { label: "Rückgängig", run: () => updateJob(id, { stage: "neu" }, "Zurückgeholt") }); });
    if (act === "restore") updateJob(id, { stage: "neu" }, "Zurückgeholt");
    if (act === "purge") { purge(id); render(); reopenTrash(); toast("Endgültig gelöscht"); }
    if (act === "unkeep") { closeDrawer(); updateJob(id, { stage: "neu" }, "Zurück zu den Treffern"); }
    if (act === "remove") { closeDrawer(); updateJob(id, { stage: "verworfen" }, "Entfernt"); toast("Stelle entfernt", { label: "Rückgängig", run: () => updateJob(id, { stage: "pipeline" }, "Wiederhergestellt") }); }
  });
  document.addEventListener("input", e => {
    if (e.target.id === "q") { state.q = e.target.value; render(); }
    if (e.target.id === "d-notes") {
      const id = state.openId, val = e.target.value;
      if (noteTimer) clearTimeout(noteTimer.t);
      $("#d-saved").textContent = "Speichert…";
      noteTimer = { id, val, t: setTimeout(() => { noteTimer = null; saveNotes(id, val); }, 900) };
    }
  });
  document.addEventListener("change", e => {
    const id = state.openId;
    if (e.target.id === "sort") { state.sort = e.target.value; render(); }
    if (!id) return;
    const j = state.jobs.get(id); if (!j) return;
    if (e.target.id === "d-deadline" && (j.deadline || "") !== e.target.value) updateJob(id, { deadline: e.target.value });
    if (e.target.id === "d-applied" && (j.appliedAt || "") !== e.target.value) updateJob(id, { appliedAt: e.target.value });
    if (e.target.id === "d-contact" && (j.contact || "") !== e.target.value) updateJob(id, { contact: e.target.value });
  });
  document.addEventListener("focusout", e => { if (e.target.id === "d-notes") flushNotes(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && state.openId) closeDrawer(); });
  document.addEventListener("submit", e => {
    if (e.target.id !== "pform") return;
    e.preventDefault();
    const fd = new FormData(e.target);
    const next = {
      roles: fd.get("roles").trim(), keywords: fd.get("keywords").trim(), locations: fd.get("locations").trim(),
      radius: fd.get("radius") ? Number(fd.get("radius")) : null, workload: fd.get("workload").trim(),
      minSalary: fd.get("minSalary") ? Number(fd.get("minSalary")) : null, level: fd.get("level"),
      languages: fd.get("languages").trim(), exclude: fd.get("exclude").trim(), about: fd.get("about").trim(),
      portals: fd.getAll("portals"), updatedAt: nowIso(),
    };
    const merged = { ...(state.profile || {}), ...next };
    state.profile = merged;
    $("#psaved").textContent = "Speichert…";
    write("settings-profile", () => sb.from("settings").upsert({ id: "profile", data: merged, updated_at: merged.updatedAt }))
      .then(() => { $("#psaved").textContent = "Gespeichert " + fmtShort(merged.updatedAt); toast("Suchprofil gespeichert"); })
      .catch(() => { $("#psaved").textContent = "Nicht gespeichert."; });
  });

  /* Drag & Drop auf dem Board */
  let dragId = null;
  document.addEventListener("dragstart", e => { const m = e.target.closest && e.target.closest(".mini"); if (!m) return; dragId = m.dataset.open; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragId); } catch {} });
  document.addEventListener("dragover", e => { const c = e.target.closest && e.target.closest(".col"); if (!c || !dragId) return; e.preventDefault(); document.querySelectorAll(".col.drop").forEach(x => x !== c && x.classList.remove("drop")); c.classList.add("drop"); });
  document.addEventListener("dragleave", e => { const c = e.target.closest && e.target.closest(".col"); if (c && !c.contains(e.relatedTarget)) c.classList.remove("drop"); });
  document.addEventListener("drop", e => { const c = e.target.closest && e.target.closest(".col"); if (!c || !dragId) return; e.preventDefault(); c.classList.remove("drop"); setStatus(dragId, c.dataset.col); dragId = null; });
  document.addEventListener("dragend", () => { dragId = null; document.querySelectorAll(".col.drop").forEach(x => x.classList.remove("drop")); });

  /* ---------- Navigation ---------- */
  const VIEWS = ["neu", "pipeline", "profil"];
  function go(v) { if (!VIEWS.includes(v)) v = "neu"; state.q = ""; if (location.hash !== "#" + v) location.hash = v; else { state.view = v; render(); window.scrollTo(0, 0); } }
  window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (!VIEWS.includes(v)) return; state.view = v; render(); window.scrollTo(0, 0); });
  state.view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "neu";

  function setSync(kind, text) { const el = $("#sync"); el.className = "sync " + kind; el.querySelector(".txt").textContent = text; el.title = text; }

  /* ---------- Daten laden und live abgleichen ---------- */
  let channel = null;
  async function loadAll() {
    state.error = null;
    const [jr, sr] = await Promise.all([sb.from("jobs").select("*"), sb.from("settings").select("id,data").eq("id", "profile")]);
    if (jr.error || sr.error) {
      console.error(jr.error || sr.error);
      state.error = "Die Daten konnten nicht geladen werden. Prüfe die Internetverbindung und lade die Seite neu.";
      setSync("err", "Fehler"); state.loaded = true; render(); return;
    }
    state.jobs = new Map(jr.data.map(r => [r.id, fromRow(r)]));
    state.profile = sr.data[0] ? sr.data[0].data : null;
    state.loaded = true;
    render();
  }
  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("stellenradar")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, p => {
        if (p.eventType === "DELETE") state.jobs.delete(p.old.id);
        else state.jobs.set(p.new.id, fromRow(p.new));
        render();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, p => {
        if (p.new && p.new.id === "profile") { state.profile = p.new.data; render(); }
      })
      .subscribe(status => {
        if (status === "SUBSCRIBED") { setSync("live", "Synchron"); loadAll(); }
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setSync("err", "Getrennt");
        else if (status === "CLOSED") setSync("", "Offline");
      });
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.user) loadAll(); });

  /* ---------- Anmeldung ---------- */
  function showLogin(msg) {
    document.body.classList.add("logged-out");
    $("#main").innerHTML = "";
    $("#login").hidden = false;
    $("#login-msg").textContent = msg || "";
  }
  function hideLogin() { document.body.classList.remove("logged-out"); $("#login").hidden = true; }
  let mode = "login";
  $("#login-switch").addEventListener("click", () => {
    mode = mode === "login" ? "signup" : "login";
    $("#login-title").textContent = mode === "login" ? "Anmelden" : "Konto erstellen";
    $("#login-submit").textContent = mode === "login" ? "Anmelden" : "Konto erstellen";
    $("#login-switch").textContent = mode === "login" ? "Noch kein Konto? Konto erstellen" : "Schon ein Konto? Anmelden";
    $("#l-pass").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("#login-msg").textContent = "";
  });
  $("#login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("#l-email").value.trim(), password = $("#l-pass").value;
    const btn = $("#login-submit"); btn.disabled = true;
    $("#login-msg").textContent = mode === "login" ? "Melde an…" : "Erstelle Konto…";
    const { error, data } = mode === "login"
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
    btn.disabled = false;
    if (error) {
      const m = error.message || "";
      $("#login-msg").textContent =
        /invalid login/i.test(m) ? "E-Mail oder Passwort stimmt nicht." :
        /not confirmed/i.test(m) ? "Deine E-Mail-Adresse ist noch nicht bestätigt. Klick auf den Link in der Bestätigungs-Mail." :
        /signups? not allowed|disabled/i.test(m) ? "Neue Konten sind gesperrt. Melde dich mit deinem bestehenden Konto an." :
        /password/i.test(m) ? "Das Passwort muss mindestens 6 Zeichen haben." : "Das hat nicht geklappt: " + m;
      return;
    }
    if (mode === "signup" && !data.session) $("#login-msg").textContent = "Konto erstellt. Bestätige jetzt den Link in der E-Mail, dann kannst du dich anmelden.";
  });

  sb.auth.onAuthStateChange((event, session) => {
    const u = session ? session.user : null;
    if (u && (!state.user || state.user.id !== u.id)) {
      state.user = u; hideLogin(); render(); subscribe();
    } else if (!u && state.user !== null) {
      state.user = null; state.jobs = new Map(); state.loaded = false;
      if (channel) { sb.removeChannel(channel); channel = null; }
      setSync("", "Abgemeldet"); showLogin();
    } else if (!u) {
      state.user = null; setSync("", "Abgemeldet"); showLogin();
    }
  });
})();
