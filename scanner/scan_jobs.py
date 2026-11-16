#!/usr/bin/env python3
"""Stellenradar-Suchlauf: holt neue Inserate von jobs.ch (JobCloud-Netz, deckt auch
jobup.ch und jobscout24.ch ab) und gibt Kandidaten als JSON aus.

Das Skript bewertet nichts. Es sammelt nur Rohdaten. Die Bewertung (Match-Wert,
Kurzbeschrieb) und das Schreiben ins Dashboard macht der geplante Claude-Suchlauf.

Aufruf:
  python3 scan_jobs.py --known known_ids.txt --out candidates.json \
      --terms "mediamatiker,grafiker,polygraf" [--locations sursee] [--max-age 21] [--pages 2]
"""
import argparse
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

UA = "Mozilla/5.0 (X11; Linux x86_64) Stellenradar/1.0"
SEARCH = "https://www.jobs.ch/de/stellenangebote/?term={term}&page={page}"
SEARCH_LOC = "https://www.jobs.ch/de/stellenangebote/?location={loc}&term={term}&page={page}"
# Orte im Umkreis von ca. 25 km um Sursee (jobs.ch filtert per Ortsname exakt,
# der Radius-Parameter wird bei automatischen Abfragen ignoriert).
REGION_SURSEE = (
    "Sursee,Schenkon,Oberkirch,Nottwil,Sempach,Neuenkirch,Rothenburg,Emmen,Emmenbrücke,"
    "Luzern,Kriens,Ebikon,Hochdorf,Beromünster,Hitzkirch,Triengen,Dagmersellen,Reiden,"
    "Zofingen,Oftringen,Aarburg,Willisau,Ruswil,Wolhusen,Malters,Menziken,Reinach AG,"
    "Schöftland,Zell LU,Buttisholz"
)
LD_RE = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
SKIP_TITLE = re.compile(
    r"lehrstelle|lernende|apprenti|apprentissage|ausbildungsplatz|\blehre\b|schnupper", re.I
)


def fetch(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "de-CH,de"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print(f"WARN fetch failed {url}: {e}", file=sys.stderr)
                return ""
            time.sleep(1.5 * (i + 1))


def ld_postings(page_html):
    out = []
    for m in LD_RE.finditer(page_html):
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            it = stack.pop()
            if isinstance(it, list):
                stack.extend(it)
            elif isinstance(it, dict):
                if it.get("@type") == "JobPosting":
                    out.append(it)
                for k in ("itemListElement", "item"):
                    if k in it:
                        stack.append(it[k])
    return out


def job_id(p):
    m = re.search(r"/detail/([0-9a-f-]{36})", p.get("url", ""))
    if m:
        return m.group(1)
    ident = p.get("identifier") or {}
    return ident.get("value")


def strip_html(s):
    s = re.sub(r"<(br|/p|/li|/h\d)[^>]*>", "\n", s or "", flags=re.I)
    s = re.sub(r"<li[^>]*>", "\n- ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t ]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def addr(p):
    loc = p.get("jobLocation") or {}
    if isinstance(loc, list):
        loc = loc[0] if loc else {}
    a = loc.get("address") or {}
    parts = [a.get("postalCode"), a.get("addressLocality") or a.get("addressRegion")]
    return " ".join(x for x in parts if x)


def salary(p):
    v = ((p.get("baseSalary") or {}).get("value") or {})
    lo, hi, unit = v.get("minValue"), v.get("maxValue"), v.get("unitText")
    if not (lo or hi):
        return ""
    rng = f"{int(lo):,}".replace(",", "'") if lo else ""
    if hi and hi != lo:
        rng += ("–" if rng else "") + f"{int(hi):,}".replace(",", "'")
    return f"CHF {rng}" + (f" / {unit}" if unit else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--terms", required=True, help="Kommagetrennte Suchbegriffe")
    ap.add_argument("--known", help="Datei mit bekannten IDs (eine pro Zeile)")
    ap.add_argument("--out", default="-")
    ap.add_argument("--max-age", type=int, default=21, help="Max. Alter in Tagen")
    ap.add_argument("--pages", type=int, default=2)
    ap.add_argument("--keep-apprenticeships", action="store_true")
    ap.add_argument("--locations", default="",
                    help='Kommagetrennte Orte; "sursee" = Region Sursee 25 km. Leer = ganze Schweiz')
    a = ap.parse_args()
    locs = REGION_SURSEE if a.locations.strip().lower() == "sursee" else a.locations
    locs = [l.strip() for l in locs.split(",") if l.strip()] or [None]

    known = set()
    if a.known:
        try:
            known = {l.strip() for l in open(a.known, encoding="utf8") if l.strip()}
        except FileNotFoundError:
            pass

    cutoff = datetime.now(timezone.utc) - timedelta(days=a.max_age)
    seen, hits = set(), []
    queries = [(t.strip(), loc) for loc in locs for t in a.terms.split(",") if t.strip()]
    for term, loc in queries:
        for page in range(1, a.pages + 1):
            if loc:
                url = SEARCH_LOC.format(loc=urllib.parse.quote(loc), term=urllib.parse.quote(term), page=page)
            else:
                url = SEARCH.format(term=urllib.parse.quote(term), page=page)
            h = fetch(url)
            posts = ld_postings(h)
            if not posts:
                break
            for p in posts:
                jid = job_id(p)
                if not jid or jid in seen:
                    continue
                seen.add(jid)
                if f"jobsch-{jid}" in known:
                    continue
                if not a.keep_apprenticeships and SKIP_TITLE.search(p.get("title", "")):
                    continue
                try:
                    posted = datetime.fromisoformat(p.get("datePosted", "").replace("Z", "+00:00"))
                    if posted < cutoff:
                        continue
                except ValueError:
                    pass
                hits.append((term if not loc else f"{term} @ {loc}", jid))
            time.sleep(0.4)
            if len(posts) < 20:
                break

    out = []
    for term, jid in hits:
        url = f"https://www.jobs.ch/de/stellenangebote/detail/{jid}/"
        detail = ld_postings(fetch(url))
        p = detail[0] if detail else {}
        if not p:
            continue
        org = p.get("hiringOrganization") or {}
        contact = p.get("applicationContact") or org.get("contactPoint") or {}
        out.append({
            "doc_id": f"jobsch-{jid}",
            "matchedTerm": term,
            "title": p.get("title", "").strip(),
            "company": org.get("name", ""),
            "location": addr(p),
            "workHours": p.get("workHours", ""),
            "employmentType": p.get("employmentType", ""),
            "salary": salary(p),
            "datePosted": p.get("datePosted", ""),
            "validThrough": p.get("validThrough", ""),
            "industry": p.get("industry", ""),
            "contact": " · ".join(x for x in [contact.get("name"), contact.get("telephone"), contact.get("email")] if x),
            "url": url,
            "description": strip_html(p.get("description", ""))[:4000],
        })
        time.sleep(0.6)

    js = json.dumps(out, ensure_ascii=False, indent=1)
    if a.out == "-":
        print(js)
    else:
        open(a.out, "w", encoding="utf8").write(js)
        print(f"{len(out)} neue Kandidaten -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
