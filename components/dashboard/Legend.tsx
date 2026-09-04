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

import { useState } from 'react';

const ROWS: { swatch: React.ReactNode; label: string }[] = [
  { swatch: <span className="inline-block h-3 w-3 rounded-full" style={{ background: '#ff5b32' }} />, label: 'rond rouge = signal intense (probablement feu étendu)' },
  { swatch: <span className="inline-block h-3 w-3 rounded-full" style={{ background: '#f5b942' }} />, label: 'rond orange = signal modéré' },
  { swatch: <span className="inline-block h-3 w-3 rounded-full" style={{ background: '#63dda0' }} />, label: 'rond vert = signal faible (observation)' },
  { swatch: <span className="inline-flex items-center gap-0.5"><span className="h-1.5 w-1.5 rounded-full bg-white/60" /><span className="h-2.5 w-2.5 rounded-full bg-white/60" /><span className="h-3.5 w-3.5 rounded-full bg-white/60" /></span>, label: 'taille du rond = intensité du signal (FRP)' },
  { swatch: <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[#062017]" style={{ background: '#ff5b32' }} />, label: 'point rouge = village à proximité immédiate' },
  { swatch: <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[#062017]" style={{ background: '#4fa3ff' }} />, label: 'point bleu = village sous le vent' },
  { swatch: <span className="text-base leading-none text-[#4fa3ff]">↑</span>, label: 'flèche = direction vers laquelle souffle le vent' },
  { swatch: <span className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: '#7aa697' }} />, label: 'trait pointillé = lien feu → village exposé' },
  { swatch: <span className="inline-block h-3 w-3 rounded-full border-2 border-dashed" style={{ borderColor: '#8da79d' }} />, label: 'rond pointillé = position approximative Meteosat (±3km), non confirmé par satellite polaire' },
  { swatch: <span className="inline-block h-3 w-3 rounded-full border-2 border-dotted" style={{ borderColor: '#4fa3ff' }} />, label: 'rond en pointillés fins = position approximative Sentinel-3 SLSTR (±1km), non corroboré par VIIRS' },
];

export default function Legend() {
  const [open, setOpen] = useState(false);

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-[1000] max-w-[calc(100vw-24px)] rounded-xl border border-white/10 bg-[#07120f]/95 text-xs text-[#c9dbd3] shadow-lg backdrop-blur">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between gap-3 px-3 py-2 font-semibold">
        Légende
        <span className="text-[#8da79d]">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <ul className="space-y-1.5 border-t border-white/10 px-3 py-2">
            {ROWS.map((row, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-4 shrink-0">{row.swatch}</span>
                {row.label}
              </li>
            ))}
          </ul>
          <div className="border-t border-white/10 px-3 py-2 text-[11px] text-[#8da79d]">
            Sources : NASA FIRMS · MTG Active Fire Monitoring — EUMETSAT · Copernicus Sentinel-3 SLSTR · Open-Meteo
          </div>
        </>
      )}
    </div>
  );
}
