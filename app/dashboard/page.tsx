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
import { useEffect, useMemo, useState } from 'react';
import EventDetail from '@/components/dashboard/EventDetail';
import type { DashboardEvent } from '@/components/dashboard/types';

const DashboardMap = dynamic(() => import('@/components/dashboard/Map'), { ssr: false, loading: () => <div className="grid h-full place-items-center text-sm text-[#8da79d]">Chargement de la carte…</div> });

const STATUS_COLOR: Record<DashboardEvent['status'], string> = { urgent: '#ff5b32', corroborated: '#f5b942', observation: '#4fa37a' };
const STATUS_LABEL: Record<DashboardEvent['status'], string> = { urgent: 'Urgent', corroborated: 'Corroboré', observation: 'Observation' };
const REFRESH_MS = 5 * 60_000;

export default function Dashboard() {
  const [authChecked, setAuthChecked] = useState(false);
  const [tab, setTab] = useState<'live' | 'history'>('live');
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [wilayas, setWilayas] = useState<string[]>([]);
  const [wilayaFilter, setWilayaFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  const [historyFrom, setHistoryFrom] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const [historyTo, setHistoryTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [historyEvents, setHistoryEvents] = useState<DashboardEvent[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);

  useEffect(() => {
    fetch('/api/dashboard/session').then(r => r.json() as Promise<{ authenticated: boolean }>).then(d => {
      if (!d.authenticated) { window.location.href = '/login'; return; }
      setAuthChecked(true);
    }).catch(() => { window.location.href = '/login'; });
  }, []);

  async function loadEvents() {
    const params = new URLSearchParams();
    if (wilayaFilter !== 'all') params.set('wilaya', wilayaFilter);
    const r = await fetch(`/api/dashboard/events?${params}`);
    if (r.status === 401) { window.location.href = '/login'; return; }
    const d = await r.json() as { events: DashboardEvent[]; updatedAt: string };
    setEvents(d.events);
    setUpdatedAt(d.updatedAt);
  }

  useEffect(() => {
    if (!authChecked) return;
    loadEvents();
    fetch('/api/dashboard/wilayas').then(r => r.json() as Promise<{ wilayas: string[] }>).then(d => setWilayas(d.wilayas)).catch(() => {});
    const id = setInterval(loadEvents, REFRESH_MS);
    return () => clearInterval(id);
  }, [authChecked, wilayaFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runHistorySearch() {
    setHistoryBusy(true);
    try {
      const from = new Date(historyFrom + 'T00:00:00Z').toISOString();
      const to = new Date(historyTo + 'T23:59:59Z').toISOString();
      const r = await fetch(`/api/dashboard/history?from=${from}&to=${to}`);
      const d = await r.json() as { events: DashboardEvent[] };
      setHistoryEvents(d.events ?? []);
    } finally {
      setHistoryBusy(false);
    }
  }

  const visible = tab === 'live' ? events : historyEvents;
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

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[1000] flex items-start justify-between gap-2 p-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-white/10 bg-[#07120f]/90 px-3 py-2 text-xs backdrop-blur">
          <span className="font-semibold">OzarEye</span>
          <span className="text-[#8da79d]">{updatedAt ? `dernière mise à jour ${new Date(updatedAt).toLocaleTimeString('fr-FR', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit' })}` : '…'}</span>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <select
            value={wilayaFilter}
            onChange={e => setWilayaFilter(e.target.value)}
            className="rounded-xl border border-white/10 bg-[#07120f]/90 px-3 py-2 text-xs backdrop-blur"
          >
            <option value="all">Toutes les wilayas</option>
            {wilayas.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
          <a href="/setup" className="rounded-xl border border-white/10 bg-[#07120f]/90 px-3 py-2 text-xs text-[#8da79d] backdrop-blur hover:text-[#edf5ef]">Configuration</a>
        </div>
      </div>

      {/* Side panel (desktop) / bottom sheet (mobile) */}
      <div className={`absolute z-[1000] flex flex-col border-white/10 bg-[#0b1d18] shadow-2xl transition-transform
        inset-x-0 bottom-0 max-h-[55vh] rounded-t-2xl border-t
        md:inset-y-0 md:right-0 md:left-auto md:bottom-auto md:h-full md:max-h-none md:w-[380px] md:rounded-none md:border-t-0 md:border-l
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
          <div className="flex items-center gap-2 border-b border-white/10 p-3 text-xs">
            <input type="date" value={historyFrom} onChange={e => setHistoryFrom(e.target.value)} className="flex-1 rounded-lg border border-white/10 bg-[#07130f] px-2 py-1.5" />
            <span className="text-[#8da79d]">→</span>
            <input type="date" value={historyTo} onChange={e => setHistoryTo(e.target.value)} className="flex-1 rounded-lg border border-white/10 bg-[#07130f] px-2 py-1.5" />
            <button onClick={runHistorySearch} disabled={historyBusy} className="rounded-lg bg-[#45d892] px-3 py-1.5 font-semibold text-[#062017] disabled:opacity-50">{historyBusy ? '…' : 'OK'}</button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {detailEvent ? (
            <EventDetail event={detailEvent} onBack={() => setDetailId(null)} />
          ) : (
            <EventList events={visible} onSelect={showDetail} />
          )}
        </div>
      </div>
    </div>
  );
}

function EventList({ events, onSelect }: { events: DashboardEvent[]; onSelect: (id: string) => void }) {
  if (!events.length) return <p className="p-4 text-sm text-[#8da79d]">Aucun événement.</p>;
  return (
    <div className="space-y-2 p-3">
      {events.map(ev => {
        const top = ev.selection[0]?.village;
        return (
          <button key={ev.id} onClick={() => onSelect(ev.id)} className="w-full rounded-xl border border-white/10 bg-[#07130f] p-3 text-left hover:border-white/20">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[ev.status] }} />
                {ev.wilaya ?? 'Wilaya inconnue'}
              </span>
              <span className="text-xs text-[#8da79d]">{ev.detectedAtAlgiers}</span>
            </div>
            <p className="mt-1 text-xs text-[#8da79d]">FRP {ev.maxFrp.toFixed(1)}MW · {STATUS_LABEL[ev.status]}{top ? ` · près de ${top.name}` : ''}</p>
          </button>
        );
      })}
    </div>
  );
}

