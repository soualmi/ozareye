'use client';

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { blowsTowardDeg } from '@/lib/wind';
import type { DashboardEvent, VillageBase } from './types';

const VILLAGE_ZOOM_THRESHOLD = 11;

function fireIcon(status: DashboardEvent['status'], frp: number, selected: boolean) {
  const color = status === 'urgent' ? '#ff5b32' : status === 'corroborated' ? '#f5b942' : '#63dda0';
  const size = Math.min(34, Math.max(14, 10 + Math.sqrt(frp) * 2));
  const ring = selected ? `box-shadow:0 0 0 3px #fff, 0 0 0 5px ${color};` : '';
  return L.divIcon({
    className: '', html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};opacity:.9;${ring}"></div>`,
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
          <Tooltip direction="top">{v.name}</Tooltip>
        </Marker>
      ))}
    </>
  );
}

export default function DashboardMap({ events, selectedId, onSelect }: {
  events: DashboardEvent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selectedEvent = events.find(e => e.id === selectedId) ?? null;
  const flyTarget = useRef<[number, number] | null>(null);
  if (selectedEvent) flyTarget.current = [selectedEvent.latitude, selectedEvent.longitude];

  return (
    <MapContainer center={[36.4, 5.0]} zoom={8} style={{ height: '100%', width: '100%' }} preferCanvas>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {events.map(ev => (
        <Marker
          key={ev.id}
          position={[ev.latitude, ev.longitude]}
          icon={fireIcon(ev.status, ev.maxFrp, ev.id === selectedId)}
          eventHandlers={{ click: () => onSelect(ev.id) }}
        >
          <Tooltip direction="top">{ev.wilaya ?? 'Wilaya inconnue'} · FRP {ev.maxFrp.toFixed(1)}MW</Tooltip>
        </Marker>
      ))}

      {selectedEvent && selectedEvent.selection.map(({ village, isProximity }) => (
        <Marker key={village.osm_id} position={[village.lat, village.lon]} icon={villageIcon(isProximity)}>
          <Tooltip direction="top" permanent>{village.name}</Tooltip>
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
  );
}
