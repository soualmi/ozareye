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

import { blowsTowardDeg, cardinalFr } from '@/lib/wind';
import { formatAge, formatDetectedAgo, wilayaLabel } from './format';
import type { DashboardEvent } from './types';

// Dashboard-only narrative rendering. Every value below comes straight off
// the DashboardEvent the API already computed from stored fields — nothing
// here invents a number (no hectare estimate, no definite trajectory).
// Telegram's telegramText() and the engine are untouched by this file.

// FIRMS' map reads its view out of the URL hash: #d:<window>;@<lon>,<lat>,<zoom>z
// — longitude first, and the app normalises it in place (…@5.00,36.40,9.00z),
// which is how this format was verified against the live map before hardcoding.
function firmsMapUrl(latitude: number, longitude: number, zoom = 10): string {
  return `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${longitude.toFixed(2)},${latitude.toFixed(2)},${zoom.toFixed(2)}z`;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function EventDetail({ event, onBack }: { event: DashboardEvent; onBack: () => void }) {
  const age = formatAge(event.ageMinutes);
  const wilayaBit = event.wilaya ? ` dans la wilaya de ${event.wilaya}` : '';
  const hasWind = event.windKph !== undefined && event.windDirectionFromDeg !== undefined;
  const towardCardinal = hasWind ? cardinalFr(blowsTowardDeg(event.windDirectionFromDeg!)) : null;
  const fromCardinal = hasWind ? cardinalFr(event.windDirectionFromDeg!) : null;

  const proximity = event.selection.filter(s => s.isProximity);
  const downwind = event.selection.filter(s => !s.isProximity);
  const satelliteNames = [...new Set(event.passes.map(p => `${p.satellite} (${p.instrument})`))].join(', ');

  return (
    <div className="p-3 text-sm">
      <button onClick={onBack} className="mb-3 text-xs text-[#8da79d] hover:text-white">← Retour à la liste</button>

      {/* 1. Status headline */}
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: event.status === 'urgent' ? '#ff5b32' : event.status === 'corroborated' ? '#f5b942' : '#4fa37a' }} />
        <h2 className="text-base font-semibold">Anomalie thermique — probablement un feu</h2>
      </div>

      {/* Item 2: what the passes actually establish. Repetition proves the
          heat source persisted, not that it is a vegetation fire, and never
          that anyone has checked it on the ground. */}
      <p className="mb-3 rounded-lg border border-white/10 bg-[#07130f] px-3 py-2 text-xs text-[#c9dbd3]">{event.sourceStatusLine}</p>

      {/* 2. One paragraph */}
      <p className="mb-4 leading-relaxed text-[#c9dbd3]">
        Anomalie thermique détectée par satellite{wilayaBit}, probablement un feu de végétation (mais peut être un brûlage agricole ou une source industrielle — à vérifier).
        {' '}Détectée il y a {age} — il s&apos;agit de l&apos;heure de détection par satellite, pas nécessairement du début du feu, qui a pu commencer plus tôt.
        {' '}{capitalize(event.magnitude)}.
      </p>

      {/* 2b. Land-use context, when the site is a known industrial/energy feature */}
      {event.industrialNote && (
        <div className="mb-4 rounded-xl border border-[#f5b942]/40 bg-[#f5b942]/10 p-3 text-xs text-[#f5d98a]">
          🏭 {event.industrialNote}
        </div>
      )}

      {/* 3. CONSTATÉ / PROBABLE */}
      <div className="mb-3 rounded-xl border border-white/10 bg-[#07130f] p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#63dda0]">Constaté</h3>
        <ul className="space-y-1 text-xs text-[#c9dbd3]">
          <li>Position : {event.latitude.toFixed(4)}, {event.longitude.toFixed(4)} · {wilayaLabel(event.wilaya)}</li>
          <li>Intensité : FRP {event.maxFrp.toFixed(1)} MW ({event.magnitude})</li>
          <li>Dernier passage satellite : {event.detectedAtAlgiers} (Alger)</li>
          <li>Détecté il y a {formatDetectedAgo(event.ageMinutes)}</li>
          <li>Satellites : {satelliteNames || '—'}</li>
        </ul>

        {/* Item 8: the same point on NASA's own map, for cross-checking. */}
        <a
          href={firmsMapUrl(event.latitude, event.longitude)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex w-full items-center justify-center rounded-lg border border-white/15 bg-[#0b1d18] px-3 py-2 text-xs font-medium text-[#63dda0] hover:border-[#45d892]/60"
        >
          Voir sur NASA FIRMS ↗
        </a>
      </div>

      <div className="mb-4 rounded-xl border border-[#f5b942]/25 bg-[#f5b942]/5 p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#f5b942]">Probable</h3>
        {hasWind ? (
          <p className="text-xs text-[#e4d9b8]">
            Le vent souffle vers le {towardCardinal} à {event.windKph} km/h : le feu pourrait donc se propager vers
            {downwind.length ? ` ces villages sous le vent : ${downwind.map(d => d.village.name).join(', ')}.` : ' les villages sous le vent, mais aucun n\'est recensé dans un rayon de 20 km.'}
          </p>
        ) : (
          <p className="text-xs text-[#e4d9b8]">Direction du vent non disponible pour cet événement — propagation probable non estimée.</p>
        )}
        <p className="mt-2 text-[11px] italic text-[#b9ac86]">La propagation réelle dépend aussi du relief, de la pente et de la végétation, non pris en compte ici.</p>
      </div>

      {/* 4. Villages */}
      <div className="mb-4 space-y-2">
        <div>
          <p className="mb-1 text-xs font-semibold text-[#8da79d]">À proximité immédiate (&lt;3km)</p>
          {proximity.length
            ? proximity.map(({ village }) => <p key={village.osm_id} className="text-xs">⚠️ {village.name} — {village.distanceKm.toFixed(1)}km</p>)
            : <p className="text-xs text-[#8da79d]">Aucun village à moins de 3km.</p>}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-[#8da79d]">Sous le vent</p>
          {downwind.length
            ? downwind.map(({ village }) => (
              <p key={village.osm_id} className="text-xs">⚠️ {village.name} — {village.distanceKm.toFixed(1)}km{village.etaHours !== undefined ? ` · estimation ~${village.etaHours < 1 ? '<1h' : village.etaHours <= 3 ? '1-3h' : '>3h'}` : ''}</p>
            ))
            : <p className="text-xs text-[#8da79d]">Aucun village sous le vent recensé.</p>}
        </div>
      </div>

      {/* 5. Technical details */}
      <details className="mb-4 rounded-xl border border-white/10 bg-[#07130f] p-3 text-xs">
        <summary className="cursor-pointer select-none font-semibold text-[#8da79d]">Détails techniques</summary>
        <div className="mt-3 space-y-3">
          <div>
            <p className="mb-1 font-medium text-[#c9dbd3]">Passages satellite</p>
            {event.passes.map((p, i) => <p key={i} className="text-[#8da79d]">{p.satellite} ({p.instrument}) — {p.acquiredAtAlgiers} (Alger)</p>)}
          </div>
          <ul className="space-y-1 text-[#8da79d]">
            <li>FRP : {event.maxFrp.toFixed(1)} MW — Puissance Radiative du Feu, énergie émise détectée par le capteur ; indicateur d&apos;intensité, pas une mesure directe de surface brûlée.</li>
            <li>Confiance satellite : {event.confidenceLabel}</li>
            <li>Passages distincts : {event.passCount}</li>
            <li>Pixels regroupés dans un même passage : {event.maxPixelsInSinglePass}</li>
            {hasWind && <li>Vent : {event.windKph} km/h, soufflant depuis le {fromCardinal} vers le {towardCardinal}</li>}
            {event.humidity !== undefined && <li>Humidité relative : {event.humidity}%</li>}
            <li>Coordonnées : {event.latitude.toFixed(5)}, {event.longitude.toFixed(5)}</li>
            <li>Wilaya : {wilayaLabel(event.wilaya)}</li>
          </ul>
          <p className="text-[#8da79d]">
            VIIRS (Visible Infrared Imaging Radiometer Suite) est un capteur en orbite polaire, résolution au sol d&apos;environ 375m,
            qui ne survole une même zone que 2 à 4 fois par jour — d&apos;où un décalage inhérent entre le départ réel d&apos;un feu et sa première détection satellite.
          </p>
        </div>
      </details>

      {/* 6. Disclaimer + credit */}
      <p className="mb-1 text-xs text-[#8da79d]">⚠️ {event.disclaimer}</p>
      <p className="text-[10px] text-[#5f7a70]">NASA FIRMS · Open-Meteo</p>
    </div>
  );
}
