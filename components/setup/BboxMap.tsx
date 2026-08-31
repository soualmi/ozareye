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
import { useEffect, useRef } from 'react';
import { MapContainer, Marker, Rectangle, TileLayer, useMap } from 'react-leaflet';

export type Bbox = { west: number; south: number; east: number; north: number };

function handleIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:3px;background:#45d892;border:2px solid #062017;cursor:move;"></div>`,
    iconSize: [14, 14], iconAnchor: [7, 7],
  });
}

// Re-centers/fits the map whenever the bbox is replaced wholesale (country
// change), but not on every small drag — FitBounds only reacts to `fitToken`
// changing, which the parent bumps on country selection, not on drag.
function FitBounds({ bbox, fitToken }: { bbox: Bbox; fitToken: number }) {
  const map = useMap();
  const lastToken = useRef<number | null>(null);
  useEffect(() => {
    if (fitToken === lastToken.current) return;
    lastToken.current = fitToken;
    map.fitBounds([[bbox.south, bbox.west], [bbox.north, bbox.east]], { padding: [20, 20] });
  }, [fitToken, bbox, map]);
  return null;
}

// A draggable/resizable rectangle built from two opposite-corner markers
// (south-west, north-east) instead of a heavier drawing plugin — dragging
// either corner recomputes the rectangle's bounds from the two corners, and
// the numeric bbox fields elsewhere on /setup stay in sync via onChange.
export default function BboxMap({ bbox, onChange, fitToken }: { bbox: Bbox; onChange: (bbox: Bbox) => void; fitToken: number }) {
  function onDragSW(lat: number, lng: number) {
    onChange({ west: lng, south: lat, east: bbox.east, north: bbox.north });
  }
  function onDragNE(lat: number, lng: number) {
    onChange({ west: bbox.west, south: bbox.south, east: lng, north: lat });
  }

  return (
    <MapContainer center={[(bbox.south + bbox.north) / 2, (bbox.west + bbox.east) / 2]} zoom={5} style={{ height: '100%', width: '100%' }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Rectangle bounds={[[bbox.south, bbox.west], [bbox.north, bbox.east]]} pathOptions={{ color: '#45d892', weight: 2, fillOpacity: 0.08 }} />
      <Marker
        position={[bbox.south, bbox.west]}
        icon={handleIcon()}
        draggable
        eventHandlers={{ drag: e => { const p = e.target.getLatLng(); onDragSW(p.lat, p.lng); } }}
      />
      <Marker
        position={[bbox.north, bbox.east]}
        icon={handleIcon()}
        draggable
        eventHandlers={{ drag: e => { const p = e.target.getLatLng(); onDragNE(p.lat, p.lng); } }}
      />
      <FitBounds bbox={bbox} fitToken={fitToken} />
    </MapContainer>
  );
}
