# Stellenradar

Persönliches Job-Dashboard für die Stellensuche in der Schweiz.

- **Dashboard:** https://claude.ai/artifact/EeeUJ7BLxpjZPT2QGQmsKi (privat, auf Laptop und Handy nutzbar)
- **Quelle der Seite:** `dashboard/stellenradar.html`
- **Suchskript:** `scanner/scan_jobs.py` holt neue Inserate von jobs.ch (JobCloud-Netz, deckt auch jobup.ch und jobscout24.ch ab)

## Datenbank (Artifact-DB)

| Pfad | Inhalt |
| --- | --- |
| `settings/profile` | Suchprofil (Berufe, Stichworte, Orte, Pensum, Portale …), `lastScan`, `lastScanNote` |
| `settings/seen` | `ids`: alle bereits geprüften Inserat-IDs, damit nichts doppelt kommt |
| `jobs/<doc_id>` | Eine Stelle. `stage`: `neu` (Treffer), `pipeline` (behalten), `verworfen`. `status`: `offen`, `in_arbeit`, `beworben`, `interview`, `zusage`, `absage`. Dazu `notes`, `deadline`, `appliedAt`, `contact`, `history` |

Felder, die der Suchlauf pro Stelle schreibt: `title, company, location, workload, salary, url, source, postedAt, summary, matchReason, highlights[], requirements[], startDate, contact, score (0–100), stage="neu", status="offen", notes="", foundAt, updatedAt, history[]`.

## Täglicher Suchlauf

Ein geplanter Claude-Task läuft jeden Morgen:

1. Suchprofil und `settings/seen` lesen
2. `python3 scanner/scan_jobs.py --terms … --known known_ids.txt --out candidates.json`
3. Kandidaten gegen das Suchprofil bewerten, passende (Score ≥ 60) als `jobs/<doc_id>` schreiben
4. `settings/seen` und `lastScan` aktualisieren

Bestehende Stellen werden nie überschrieben.
