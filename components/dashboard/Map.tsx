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

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { Circle, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { blowsTowardDeg } from '@/lib/wind';
import { displayName } from '@/lib/place-name';
import { formatAge, wilayaLabel } from './format';
import Legend from './Legend';
import StationLine from './StationLine';
import type { DashboardEvent, VillageBase } from './types';

const VILLAGE_ZOOM_THRESHOLD = 11;

function markerLabel(event: DashboardEvent): string {
  return `Anomalie thermique, ${wilayaLabel(event.wilaya)}, FRP ${event.maxFrp.toFixed(1)} MW, détectée à ${event.detectedAtAlgiers}`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// positionSource 'meteosat'/'slstr' (rule c/e, locked): a hollow circle
// instead of a filled one — visually distinct at a glance from a
// VIIRS-anchored marker, since this position carries real uncertainty and
// has never been corroborated by a polar overpass (Meteosat) or by VIIRS
// specifically (SLSTR). Meteosat uses a dashed border, SLSTR a dotted one —
// distinct at a glance from each other too. The faint uncertainty ring
// itself is drawn separately, see DashboardMap below.
function fireIcon(status: DashboardEvent['status'], frp: number, selected: boolean, label: string, positionSource: DashboardEvent['positionSource']) {
  const color = status === 'urgent' ? '#ff5b32' : status === 'corroborated' ? '#f5b942' : '#63dda0';
  const size = Math.min(34, Math.max(14, 10 + Math.sqrt(frp) * 2));
  const ring = selected ? `box-shadow:0 0 0 3px #fff, 0 0 0 5px ${color};` : '';
  const safe = escapeHtml(label);
  const fill = positionSource === 'meteosat' ? `background:transparent;border:3px dashed ${color};`
    : positionSource === 'slstr' ? `background:transparent;border:3px dotted ${color};`
    : `background:${color};`;
  return L.divIcon({
    className: '', html: `<div role="img" aria-label="${safe}" title="${safe}" style="width:${size}px;height:${size}px;border-radius:50%;${fill}opacity:.9;${ring}"></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });
}

function villageIcon(isProximity: boolean) {
  const color = isProximity ? '#ff5b32' : '#4fa3ff';
  return L.divIcon({
    className: '', html: `<div style="width:11px;height:11px;border-radius:50%;background:${color};border:2px solid #062017;"></div>`,
    iconSize: [11, 11], iconAnchor: [5, 5],
  });
}

function extraVillageIcon() {
  return L.divIcon({
    className: '', html: `<div style="width:6px;height:6px;border-radius:50%;background:#7aa697;opacity:.7;"></div>`,
    iconSize: [6, 6], iconAnchor: [3, 3],
  });
}

function windArrowIcon(towardDeg: number) {
  return L.divIcon({
    className: '',
    html: `<div style="transform:rotate(${towardDeg}deg);width:22px;height:22px;color:#4fa3ff;font-size:22px;line-height:1;text-shadow:0 0 3px #062017;">↑</div>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
}

// Presentation-only: projects a point `km` out from (lat,lon) along `bearingDeg`,
// purely so the wind arrow can be drawn as a visible line instead of sitting
// exactly on top of the fire marker. Not exposure math — that's reused as-is
// from lib/wind.ts (blowsTowardDeg) and lib/geo.ts elsewhere in this app.
function destinationPoint(lat: number, lon: number, bearingDeg: number, km: number): [number, number] {
  const R = 6371, rad = Math.PI / 180;
  const brng = bearingDeg * rad, lat1 = lat * rad, lon1 = lon * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(km / R) + Math.cos(lat1) * Math.sin(km / R) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(km / R) * Math.cos(lat1), Math.cos(km / R) - Math.sin(lat1) * Math.sin(lat2));
  return [lat2 / rad, lon2 / rad];
}

function FlyTo({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => { if (target) map.flyTo(target, Math.max(map.getZoom(), 11), { duration: 0.8 }); }, [target, map]);
  return null;
}

function ExtraVillages({ selectedEvent }: { selectedEvent: DashboardEvent | null }) {
  const [zoom, setZoom] = useState(0);
  const [villages, setVillages] = useState<VillageBase[]>([]);
  const map = useMapEvents({
    moveend: () => refresh(),
    zoomend: () => { setZoom(map.getZoom()); refresh(); },
  });

  async function refresh() {
    const z = map.getZoom();
    setZoom(z);
    if (z < VILLAGE_ZOOM_THRESHOLD) { setVillages([]); return; }
    const b = map.getBounds();
    const bounds = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
    try {
      const r = await fetch(`/api/dashboard/villages?bounds=${bounds}`);
      const d = r.ok ? await r.json() as { villages?: VillageBase[] } : { villages: [] };
      setVillages(d.villages ?? []);
    } catch { /* transient — next moveend retries */ }
  }

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (zoom < VILLAGE_ZOOM_THRESHOLD) return null;
  // Selected fire's own exposed villages are drawn separately with distinct colours/labels — don't double them here.
  const selectedIds = new Set((selectedEvent?.selection ?? []).map(s => s.village.osm_id));
  return (
    <>
      {villages.filter(v => !selectedIds.has(v.osm_id)).map(v => (
        <Marker key={v.osm_id} position={[v.lat, v.lon]} icon={extraVillageIcon()}>
          <Tooltip direction="top">{displayName(v)}</Tooltip>
        </Marker>
      ))}
    </>
  );
}

// The compact "glance" popup — full narrative lives in the detail panel,
// opened only via the "Plus de détails" button here.
function FirePopup({ event, onDetail }: { event: DashboardEvent; onDetail: (id: string) => void }) {
  const proximityCount = event.selection.filter(s => s.isProximity).length;
  const downwindCount = event.selection.filter(s => !s.isProximity).length;
  const nearest = event.selection[0] ? displayName(event.selection[0].village) : undefined;
  const magnitudeShort = event.magnitude.split(',')[0];
  return (
    <div style={{ fontSize: 12, lineHeight: 1.5, minWidth: 180 }}>
      <strong>{event.title}</strong>
      {/* Industrial context leads, right under the title — same hierarchy
          fix as the detail panel, not a note trailing at the bottom. */}
      {event.industrialLeadLine && <div style={{ marginTop: 4, color: '#f5b942' }}>🏭 {event.industrialLeadLine}</div>}
      {!event.industrialLeadLine && event.summaryLine && <div style={{ marginTop: 4, fontWeight: 600 }}>{event.summaryLine}</div>}
      {event.positionSource === 'meteosat' && (
        <div style={{ marginTop: 4, color: '#8da79d' }}>🛰 Position approximative Meteosat (±{(event.positionUncertaintyKm ?? 3).toFixed(1)}km), non confirmé par satellite polaire</div>
      )}
      {event.positionSource === 'slstr' && (
        <div style={{ marginTop: 4, color: '#8da79d' }}>🛰 Position approximative Sentinel-3 SLSTR (±{(event.positionUncertaintyKm ?? 1).toFixed(1)}km), non corroboré par VIIRS</div>
      )}
      {event.geoTracked && <div style={{ marginTop: 4, color: '#4fa3ff' }}>🛰 Suivi Meteosat actif</div>}
      <div>{[nearest, wilayaLabel(event.wilaya)].filter(Boolean).join(' · ')}</div>
      <div>{capitalize(magnitudeShort)}</div>
      <div>Dernier passage satellite : {event.detectedAtAlgiers} (Alger)</div>
      <div>Détectée il y a {formatAge(event.ageMinutes)}</div>
      <div style={{ marginTop: 4 }}>{event.sourceStatusLine}</div>
      <div>{proximityCount} village(s) à proximité, {downwindCount} sous le vent</div>
      {event.nearestStationLine && <div style={{ marginTop: 4 }}><StationLine event={event} compact /></div>}
      <button
        onClick={() => onDetail(event.id)}
        style={{ marginTop: 6, width: '100%', border: 'none', borderRadius: 6, background: '#45d892', color: '#062017', fontWeight: 600, padding: '5px 8px', cursor: 'pointer' }}
      >
        Plus de détails →
      </button>
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function DashboardMap({ events, selectedId, onSelect, onDetail }: {
  events: DashboardEvent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDetail: (id: string) => void;
}) {
  const selectedEvent = events.find(e => e.id === selectedId) ?? null;
  const flyTarget = useRef<[number, number] | null>(null);
  if (selectedEvent) flyTarget.current = [selectedEvent.latitude, selectedEvent.longitude];

  return (
    <div className="relative h-full w-full">
    <MapContainer center={[36.4, 5.0]} zoom={8} style={{ height: '100%', width: '100%' }} preferCanvas>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {events.map(ev => (
        <Marker
          key={ev.id}
          position={[ev.latitude, ev.longitude]}
          icon={fireIcon(ev.status, ev.maxFrp, ev.id === selectedId, markerLabel(ev), ev.positionSource)}
          eventHandlers={{ click: () => onSelect(ev.id) }}
          alt={markerLabel(ev)}
        >
          <Tooltip direction="top">{wilayaLabel(ev.wilaya)} · FRP {ev.maxFrp.toFixed(1)}MW{ev.geoTracked ? ' · suivi Meteosat' : ''}</Tooltip>
          <Popup><FirePopup event={ev} onDetail={onDetail} /></Popup>
        </Marker>
      ))}
      {/* Faint ±3km uncertainty ring for a Meteosat-only position — the
          hollow marker above already signals "different kind of marker";
          this makes the actual pixel uncertainty visible at a glance. */}
      {events.filter(ev => ev.positionSource === 'meteosat').map(ev => (
        <Circle
          key={`unc-${ev.id}`}
          center={[ev.latitude, ev.longitude]}
          radius={(ev.positionUncertaintyKm ?? 3) * 1000}
          pathOptions={{ color: '#8da79d', weight: 1, fillColor: '#8da79d', fillOpacity: 0.06, dashArray: '3 5' }}
        />
      ))}
      {/* Same idea for an SLSTR-only position — a finer dash pattern and its
          own (typically ~1km, smaller) real radius keep it visually distinct
          from Meteosat's ring even where the two overlap on screen. */}
      {events.filter(ev => ev.positionSource === 'slstr').map(ev => (
        <Circle
          key={`unc-${ev.id}`}
          center={[ev.latitude, ev.longitude]}
          radius={(ev.positionUncertaintyKm ?? 1) * 1000}
          pathOptions={{ color: '#4fa3ff', weight: 1, fillColor: '#4fa3ff', fillOpacity: 0.06, dashArray: '1 3' }}
        />
      ))}

      {selectedEvent && selectedEvent.selection.map(({ village, isProximity }) => (
        <Marker key={village.osm_id} position={[village.lat, village.lon]} icon={villageIcon(isProximity)}>
          <Tooltip direction="top" permanent>{displayName(village)}</Tooltip>
          <Popup>
            <div style={{ fontSize: 12 }}>
              <strong>{displayName(village)}</strong><br />
              {village.distanceKm.toFixed(1)}km · {isProximity ? 'à proximité' : 'sous le vent'}
            </div>
          </Popup>
        </Marker>
      ))}
      {selectedEvent && selectedEvent.selection.map(({ village }) => (
        <Polyline
          key={`line-${village.osm_id}`}
          positions={[[selectedEvent.latitude, selectedEvent.longitude], [village.lat, village.lon]]}
          pathOptions={{ color: '#7aa697', weight: 1, dashArray: '4 4' }}
        />
      ))}
      {selectedEvent && selectedEvent.windDirectionFromDeg !== undefined && (() => {
        const toward = blowsTowardDeg(selectedEvent.windDirectionFromDeg);
        const tip = destinationPoint(selectedEvent.latitude, selectedEvent.longitude, toward, 3);
        return (
          <>
            <Polyline positions={[[selectedEvent.latitude, selectedEvent.longitude], tip]} pathOptions={{ color: '#4fa3ff', weight: 3 }} />
            <Marker position={tip} icon={windArrowIcon(toward)} />
          </>
        );
      })()}

      <ExtraVillages selectedEvent={selectedEvent} />
      <FlyTo target={selectedId ? flyTarget.current : null} />
    </MapContainer>
    <Legend />
    </div>
  );
}
