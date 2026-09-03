// OzarEye
// Copyright (C) 2026 H. Soualmi
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

'use client';

import dynamic from 'next/dynamic';
import { Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import EventDetail from '@/components/dashboard/EventDetail';
import { formatDetectedAgo, wilayaLabel } from '@/components/dashboard/format';
import { displayName } from '@/lib/place-name';
import type { DashboardEvent, SourceStatus } from '@/components/dashboard/types';

const DashboardMap = dynamic(() => import('@/components/dashboard/Map'), { ssr: false, loading: () => <div className="grid h-full place-items-center text-sm text-[#8da79d]">Chargement de la carte…</div> });

const STATUS_COLOR: Record<DashboardEvent['status'], string> = { urgent: '#ff5b32', corroborated: '#f5b942', observation: '#4fa37a' };
const REFRESH_MS = 5 * 60_000;

function algiersHm(iso: string) {
  return new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit' });
}

export default function Dashboard() {
  const [authChecked, setAuthChecked] = useState(false);
  const [tab, setTab] = useState<'live' | 'history'>('live');
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [wilayas, setWilayas] = useState<string[]>([]);
  const [wilayaFilter, setWilayaFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [hideUnknownWilaya, setHideUnknownWilaya] = useState(false);

  const [historyFrom, setHistoryFrom] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const [historyTo, setHistoryTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [historyEvents, setHistoryEvents] = useState<DashboardEvent[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // A fresh, unconfigured instance (no region built yet, or missing keys)
  // must land on /setup, not an empty dashboard — checked once per visit,
  // right after auth, before anything dashboard-specific renders. A
  // configured instance (this check passing) is unaffected either way.
  useEffect(() => {
    fetch('/api/dashboard/session').then(r => r.json() as Promise<{ authenticated: boolean }>).then(d => {
      if (!d.authenticated) { window.location.href = '/login'; return; }
      fetch('/api/setup/config').then(r => r.json() as Promise<{ config: { configured: boolean }; secretsConfigured: Record<string, boolean> }>).then(cfg => {
        const secretsOk = Object.values(cfg.secretsConfigured).every(Boolean);
        if (!cfg.config.configured || !secretsOk) { window.location.href = '/setup'; return; }
        setAuthChecked(true);
      }).catch(() => { setAuthChecked(true); }); // can't confirm config state — don't strand a working instance on a failed check
    }).catch(() => { window.location.href = '/login'; });
  }, []);

  async function loadEvents() {
    const params = new URLSearchParams();
    if (wilayaFilter !== 'all') params.set('wilaya', wilayaFilter);
    const r = await fetch(`/api/dashboard/events?${params}`);
    if (r.status === 401) { window.location.href = '/login'; return; }
    const d = await r.json() as { events: DashboardEvent[]; lastSyncAt: string | null; sources?: SourceStatus[] };
    setEvents(d.events);
    setLastSyncAt(d.lastSyncAt ?? null);
    setSources(d.sources ?? []);
  }

  useEffect(() => {
    if (!authChecked) return;
    loadEvents();
    fetch('/api/dashboard/wilayas').then(r => r.json() as Promise<{ wilayas: string[] }>).then(d => setWilayas(d.wilayas)).catch(() => {});
    const id = setInterval(loadEvents, REFRESH_MS);
    return () => clearInterval(id);
  }, [authChecked, wilayaFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // A failed request used to fall through to `?? []`, rendering the same
  // "Aucun événement" as a genuinely empty range — the two are now distinct:
  // 401 sends you to /login (as loadEvents does), any other failure shows an
  // error line, and only a 200 is allowed to say the range was empty.
  async function runHistorySearch() {
    setHistoryBusy(true);
    try {
      const from = new Date(historyFrom + 'T00:00:00Z').toISOString();
      const to = new Date(historyTo + 'T23:59:59Z').toISOString();
      const r = await fetch(`/api/dashboard/history?from=${from}&to=${to}`);
      if (r.status === 401) { window.location.href = '/login'; return; }
      if (!r.ok) { setHistoryError("Erreur de chargement de l'historique"); setHistoryEvents([]); return; }
      const d = await r.json() as { events: DashboardEvent[] };
      setHistoryError(null);
      setHistoryEvents(d.events ?? []);
    } catch {
      setHistoryError("Erreur de chargement de l'historique");
      setHistoryEvents([]);
    } finally {
      setHistoryBusy(false);
    }
  }

  // The search used to fire only from the OK button, so opening Historique —
  // or changing a date and not pressing OK — showed a stale/empty list that
  // read as "no events in this range". Opening the tab and editing either
  // date now runs the search; the OK button stays as an explicit re-run.
  useEffect(() => {
    if (!authChecked || tab !== 'history') return;
    runHistorySearch();
  }, [authChecked, tab, historyFrom, historyTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = tab === 'live' ? events : historyEvents;
  const visible = hideUnknownWilaya ? loaded.filter(e => e.wilaya !== null) : loaded;
  const unknownWilayaCount = loaded.filter(e => e.wilaya === null).length;
  const repeatedCount = visible.filter(e => e.passCount >= 2).length;
  const downSource = sources.find(s => !s.ok);
  const detailEvent = useMemo(() => visible.find(e => e.id === detailId) ?? null, [visible, detailId]);

  // Clicking a marker just selects it (popup + village markers/wind arrow on the
  // map — the glance layer). Clicking a list row, or "Plus de détails" in the
  // popup, opens the full narrative panel (the deep layer).
  function selectOnly(id: string) { setSelectedId(id); }
  function showDetail(id: string) { setSelectedId(id); setDetailId(id); setPanelOpen(true); }

  if (!authChecked) return <div className="grid h-screen place-items-center bg-[#07120f] text-sm text-[#8da79d]">Vérification de session…</div>;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#07120f] text-[#edf5ef]">
      <div className="absolute inset-0">
        <DashboardMap events={tab === 'live' ? events : historyEvents} selectedId={selectedId} onSelect={selectOnly} onDetail={showDetail} />
      </div>

      {/* Item 9: an open watchdog incident is the one thing that silently
          invalidates everything else on screen — an empty map could mean "no
          fires" or "no data". Banded at the very top, above the map. */}
      {downSource && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[1200] bg-[#ff5b32]/95 px-3 py-2 text-center text-xs font-medium text-[#1a0b06]">
          ⚠️ Source {downSource.name} en panne depuis {downSource.downSince ? algiersHm(downSource.downSince) : '—'} — les données peuvent être incomplètes.
        </div>
      )}

      {/* Top bar — z-[1100], strictly above the side panel's z-[1000], so its
          controls (wilaya filter, Configuration) are never painted over even
          if a future layout change makes the panel's box reach this corner
          again. flex-wrap: on a narrow viewport where both pill groups don't
          fit on one line, the right group drops to its own line instead of
          being squeezed or pushed off-screen — it stays fully visible either way. */}
      <div className={`pointer-events-none absolute inset-x-0 z-[1100] flex flex-wrap items-start justify-between gap-2 p-3 ${downSource ? 'top-9' : 'top-0'}`}>
        <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-white/10 bg-[#07120f]/90 px-3 py-2 text-xs backdrop-blur">
          <span className="font-semibold">OzarEye</span>
          {/* Item 5: the monitor's last successful FIRMS run — not the moment
              this page happened to re-render, which is what "mise à jour"
              used to show and which is never stale by construction. */}
          <span className="text-[#8da79d]">{lastSyncAt ? `Dernière synchronisation : ${algiersHm(lastSyncAt)}` : 'Synchronisation inconnue'}</span>
          {sources.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {sources.map(src => (
                <span key={src.source} title={src.ok ? `Dernier succès ${src.lastSuccessAt ? algiersHm(src.lastSuccessAt) : '—'}` : `En panne depuis ${src.downSince ? algiersHm(src.downSince) : '—'}`}
                  className={`rounded-md px-1.5 py-0.5 text-[10px] ${src.ok ? 'bg-[#4fa37a]/20 text-[#63dda0]' : 'bg-[#ff5b32]/20 text-[#ff9270]'}`}>
                  {src.name} {src.ok ? 'OK' : `en panne depuis ${src.downSince ? algiersHm(src.downSince) : '—'}`}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <select
            value={wilayaFilter}
            onChange={e => setWilayaFilter(e.target.value)}
            className="max-w-[45vw] truncate rounded-xl border border-white/10 bg-[#07120f]/90 px-3 py-2 text-xs backdrop-blur min-[480px]:max-w-none"
          >
            <option value="all">Toutes les wilayas</option>
            {wilayas.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
          {/* Item 6: under ~480px the label is dropped and the button becomes
              a square icon target, so it can't be clipped off the edge. */}
          <a href="/setup" aria-label="Configuration" title="Configuration" className="flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-[#07120f]/90 px-2.5 py-2 text-xs text-[#8da79d] backdrop-blur hover:text-[#edf5ef] min-[480px]:px-3">
            <Settings size={14} /> <span className="hidden min-[480px]:inline">Configuration</span>
          </a>
        </div>
      </div>

      {/* Side panel (desktop) / bottom sheet (mobile). Root cause of the
          missing Configuration button: this used to be md:inset-y-0 (top:0,
          bottom:0) — starting at the very top of the screen, it physically
          overlapped the top bar's right-side corner (same z-index, later in
          the DOM, so it painted over the wilaya filter and Configuration
          link). md:top-16 reserves the top bar's own height so the panel
          starts below it instead of underneath it — no overlap, so no
          stacking-order fight to begin with. */}
      <div className={`absolute z-[1000] flex flex-col border-white/10 bg-[#0b1d18] shadow-2xl transition-transform
        inset-x-0 bottom-0 max-h-[55vh] rounded-t-2xl border-t
        md:top-16 md:bottom-0 md:right-0 md:left-auto md:h-auto md:max-h-none md:w-[380px] md:rounded-none md:border-t-0 md:border-l
        ${panelOpen ? 'translate-y-0' : 'translate-y-[calc(100%-42px)] md:translate-y-0'}`}
      >
        <button onClick={() => setPanelOpen(p => !p)} className="flex items-center justify-center gap-2 border-b border-white/10 py-2.5 text-xs text-[#8da79d] md:hidden">
          <span className="h-1 w-10 rounded-full bg-white/20" /> {panelOpen ? 'Réduire' : 'Alertes'}
        </button>

        <div className="flex border-b border-white/10 text-xs">
          <button onClick={() => { setTab('live'); setSelectedId(null); setDetailId(null); }} className={`flex-1 py-2.5 font-medium ${tab === 'live' ? 'text-[#63dda0]' : 'text-[#8da79d]'}`}>En direct</button>
          <button onClick={() => { setTab('history'); setSelectedId(null); setDetailId(null); }} className={`flex-1 py-2.5 font-medium ${tab === 'history' ? 'text-[#63dda0]' : 'text-[#8da79d]'}`}>Historique</button>
        </div>

        {tab === 'history' && (
          <div className="border-b border-white/10 p-3 text-xs">
            <div className="flex items-center gap-2">
              <input type="date" value={historyFrom} onChange={e => setHistoryFrom(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#07130f] px-2 py-1.5" />
              <span className="text-[#8da79d]">→</span>
              <input type="date" value={historyTo} onChange={e => setHistoryTo(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#07130f] px-2 py-1.5" />
              <button onClick={runHistorySearch} disabled={historyBusy} className="shrink-0 rounded-lg bg-[#45d892] px-3 py-1.5 font-semibold text-[#062017] disabled:opacity-50">{historyBusy ? '…' : 'OK'}</button>
            </div>
            {historyError && <p className="mt-2 text-[#ff9270]">{historyError}</p>}
          </div>
        )}

        {/* Item 4: marquer, pas masquer — off by default, so an out-of-bounds
            detection is visible and labelled unless the reader opts out. */}
        <label className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-[11px] text-[#8da79d]">
          <input type="checkbox" checked={hideUnknownWilaya} onChange={e => setHideUnknownWilaya(e.target.checked)} className="accent-[#45d892]" />
          Masquer les points hors frontières{unknownWilayaCount > 0 ? ` (${unknownWilayaCount})` : ''}
        </label>

        {/* Item 10: "Confirmés au sol" is structurally 0 — this system has no
            ground-truth input — and is shown to make that absence explicit. */}
        <div className="border-b border-white/10 px-3 py-2 text-[11px] text-[#8da79d]">
          Observations : {visible.length} · Signaux répétés (≥2 passages) : {repeatedCount} · Confirmés au sol : 0
        </div>

        <div className="flex-1 overflow-y-auto">
          {detailEvent ? (
            <EventDetail event={detailEvent} onBack={() => setDetailId(null)} />
          ) : (
            <EventList events={visible} onSelect={showDetail} emptyMessage={tab === 'history' && historyError ? historyError : 'Aucun événement.'} />
          )}
        </div>
      </div>
    </div>
  );
}

function EventList({ events, onSelect, emptyMessage }: { events: DashboardEvent[]; onSelect: (id: string) => void; emptyMessage: string }) {
  if (!events.length) return <p className="p-4 text-sm text-[#8da79d]">{emptyMessage}</p>;
  return (
    <div className="space-y-2 p-3">
      {events.map(ev => {
        const top = ev.selection[0]?.village;
        return (
          <button key={ev.id} onClick={() => onSelect(ev.id)} className="w-full rounded-xl border border-white/10 bg-[#07130f] p-3 text-left hover:border-white/20">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[ev.status] }} />
                {wilayaLabel(ev.wilaya)}
              </span>
              <span className="text-xs text-[#8da79d]">{ev.detectedAtAlgiers}</span>
            </div>
            <p className="mt-1 text-xs text-[#8da79d]">FRP {ev.maxFrp.toFixed(1)}MW{top ? ` · près de ${displayName(top)}` : ''}</p>
            <p className="mt-1 text-[11px] text-[#8da79d]">{ev.sourceStatusLine}</p>
            {/* /history measures age from the event's own last pass, so its
                events carry ageMinutes 0 — the absolute time is always shown,
                the elapsed time only when it is a real one. */}
            <p className="mt-0.5 text-[11px] text-[#5f7a70]">Dernier passage satellite : {ev.detectedAtAlgiers}{ev.ageMinutes > 0 ? ` · Détecté il y a ${formatDetectedAgo(ev.ageMinutes)}` : ''}</p>
          </button>
        );
      })}
    </div>
  );
}

