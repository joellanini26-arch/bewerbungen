-- Stellenradar: Datenbank-Schema für Supabase
-- Im Supabase-Dashboard unter "SQL Editor" einfügen und "Run" klicken.

-- Stellen
create table if not exists public.jobs (
  id            text primary key,              -- z. B. jobsch-<uuid>
  title         text not null,
  company       text,
  location      text,
  workload      text,
  salary        text,
  url           text,
  source        text,
  posted_at     timestamptz,
  summary       text,
  match_reason  text,
  highlights    jsonb not null default '[]'::jsonb,
  requirements  jsonb not null default '[]'::jsonb,
  start_date    text,
  contact       text,
  score         integer,
  stage         text not null default 'neu'   check (stage in ('neu','pipeline','verworfen')),
  status        text not null default 'offen' check (status in ('offen','in_arbeit','beworben','interview','zusage','absage')),
  notes         text not null default '',
  notes_at      timestamptz,
  deadline      date,
  applied_at    date,
  history       jsonb not null default '[]'::jsonb,
  found_at      timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists jobs_stage_idx on public.jobs (stage);

-- Einstellungen: 'profile' (Suchprofil), 'seen' (geprüfte Inserat-IDs), 'scanner' (Suchskript)
create table if not exists public.settings (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Zugriff: nur angemeldete Personen. Nach deiner ersten Anmeldung schaltest du
-- unter Authentication > Sign In / Providers "Allow new users to sign up" aus,
-- dann bist du die einzige Person mit Zugang.
alter table public.jobs     enable row level security;
alter table public.settings enable row level security;

drop policy if exists "jobs: angemeldet" on public.jobs;
create policy "jobs: angemeldet" on public.jobs
  for all to authenticated using (true) with check (true);

drop policy if exists "settings: angemeldet" on public.settings;
create policy "settings: angemeldet" on public.settings
  for all to authenticated using (true) with check (true);

-- Live-Abgleich zwischen Laptop und Handy
do $$
begin
  begin alter publication supabase_realtime add table public.jobs;     exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.settings; exception when duplicate_object then null; end;
end $$;
