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
import { useEffect, useRef, useState } from 'react';
import type { Bbox } from '@/components/setup/BboxMap';

const BboxMap = dynamic(() => import('@/components/setup/BboxMap'), { ssr: false, loading: () => <div className="grid h-full place-items-center text-sm text-[#8da79d]">Chargement de la carte…</div> });

type Country = { iso2: string; iso3: string; name: string; flag: string };
type SecretsConfigured = { FIRMS_MAP_KEY: boolean; TELEGRAM_BOT_TOKEN: boolean; TELEGRAM_CHAT_ID: boolean };
type VillageBuildStatus =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string; step: string }
  | { status: 'success'; startedAt: string; finishedAt: string; villageCount: number; perRegion: Record<string, number>; droppedOutsideBoundary: number; adminBoundariesOk: boolean; adminBoundariesError?: string }
  | { status: 'error'; startedAt: string; finishedAt: string; error: string };
type Config = {
  countryName: string; countryIso2: string; countryIso3: string;
  bbox: Bbox;
  frpThresholdMw: number; proximityKm: number; persistentSourceDays: number;
  configured: boolean;
  villageBuildStatus: VillageBuildStatus;
};

const KEY_FIELDS: { key: keyof SecretsConfigured; label: string; help: string; helpUrl: string }[] = [
  { key: 'FIRMS_MAP_KEY', label: 'Clé NASA FIRMS', help: 'Obtenir une clé gratuite', helpUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/' },
  { key: 'TELEGRAM_BOT_TOKEN', label: 'Token du bot Telegram', help: 'Créer un bot avec BotFather', helpUrl: 'https://t.me/BotFather' },
  { key: 'TELEGRAM_CHAT_ID', label: 'Identifiant du canal/groupe Telegram', help: 'Ajouter le bot au canal, puis lire son chat_id via /getUpdates', helpUrl: 'https://core.telegram.org/bots/api#getupdates' },
];

function fmtKm2(n: number) {
  return Math.round(n).toLocaleString('fr-FR');
}

export default function Setup() {
  const [authChecked, setAuthChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<Config | null>(null);
  const [secretsConfigured, setSecretsConfigured] = useState<SecretsConfigured | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);

  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [keysSaveState, setKeysSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const [selectedIso2, setSelectedIso2] = useState('');
  const [bbox, setBbox] = useState<Bbox>({ west: -2.5, south: 34.0, east: 9.0, north: 37.3 });
  const [fitToken, setFitToken] = useState(0);
  const [bboxLookupError, setBboxLookupError] = useState<string | null>(null);

  const [frpThresholdMw, setFrpThresholdMw] = useState(20);
  const [proximityKm, setProximityKm] = useState(3);
  const [persistentSourceDays, setPersistentSourceDays] = useState(10);
  const [regionSaveState, setRegionSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [regionSaveError, setRegionSaveError] = useState<string | null>(null);

  const [buildStatus, setBuildStatus] = useState<VillageBuildStatus | null>(null);
  const [buildWarning, setBuildWarning] = useState<{ message: string; areaKm2: number } | null>(null);
  const [buildStarting, setBuildStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch('/api/dashboard/session').then(r => r.json() as Promise<{ authenticated: boolean }>).then(d => {
      if (!d.authenticated) { window.location.href = '/login'; return; }
      setAuthChecked(true);
    }).catch(() => { window.location.href = '/login'; });
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    (async () => {
      const [configRes, countriesRes] = await Promise.all([
        fetch('/api/setup/config'),
        fetch('/api/setup/countries'),
      ]);
      if (configRes.status === 401 || countriesRes.status === 401) { window.location.href = '/login'; return; }
      const configData = await configRes.json() as { config: Config; secretsConfigured: SecretsConfigured };
      const countriesData = await countriesRes.json() as { countries: Country[] };
      setConfig(configData.config);
      setSecretsConfigured(configData.secretsConfigured);
      setCountries(countriesData.countries);
      setSelectedIso2(configData.config.countryIso2);
      setBbox(configData.config.bbox);
      setFrpThresholdMw(configData.config.frpThresholdMw);
      setProximityKm(configData.config.proximityKm);
      setPersistentSourceDays(configData.config.persistentSourceDays);
      setBuildStatus(configData.config.villageBuildStatus);
      setLoading(false);
    })();
  }, [authChecked]);

  // Poll build status while a build is running (started here, or already
  // running from a previous page load — e.g. the user navigated away and back).
  useEffect(() => {
    const running = buildStatus?.status === 'running';
    if (!running) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } return; }
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      const r = await fetch('/api/setup/build');
      if (!r.ok) return;
      const d = await r.json() as { villageBuildStatus: VillageBuildStatus };
      setBuildStatus(d.villageBuildStatus);
    }, 2000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [buildStatus?.status]);

  async function saveKeys() {
    const body = Object.fromEntries(Object.entries(keyInputs).filter(([, v]) => v.trim().length > 0));
    if (Object.keys(body).length === 0) return;
    setKeysSaveState('saving');
    try {
      const r = await fetch('/api/setup/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error();
      const d = await r.json() as { secretsConfigured: SecretsConfigured };
      setSecretsConfigured(d.secretsConfigured);
      setKeyInputs({});
      setKeysSaveState('saved');
    } catch {
      setKeysSaveState('error');
    }
  }

  async function onSelectCountry(iso2: string) {
    setSelectedIso2(iso2);
    setBboxLookupError(null);
    const country = countries.find(c => c.iso2 === iso2);
    if (!country) return;
    try {
      const r = await fetch(`/api/setup/country-bbox?name=${encodeURIComponent(country.name)}`);
      const d = await r.json() as { bbox?: Bbox; error?: string };
      if (!r.ok || !d.bbox) { setBboxLookupError(d.error ?? 'Zone introuvable — saisissez-la manuellement.'); return; }
      setBbox(d.bbox);
      setFitToken(t => t + 1);
    } catch {
      setBboxLookupError('Service de géocodage indisponible — saisissez la zone manuellement.');
    }
  }

  async function saveRegion() {
    setRegionSaveState('saving');
    setRegionSaveError(null);
    const country = countries.find(c => c.iso2 === selectedIso2);
    try {
      const r = await fetch('/api/setup/region', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          countryName: country?.name, countryIso2: country?.iso2, countryIso3: country?.iso3,
          bbox, frpThresholdMw, proximityKm, persistentSourceDays,
        }),
      });
      const d = await r.json() as { config?: Config; error?: string };
      if (!r.ok || !d.config) throw new Error(d.error ?? 'Échec de l\'enregistrement');
      setConfig(d.config);
      setBuildStatus(d.config.villageBuildStatus);
      setRegionSaveState('saved');
    } catch (error) {
      setRegionSaveState('error');
      setRegionSaveError(error instanceof Error ? error.message : 'Échec de l\'enregistrement');
    }
  }

  async function startBuild(confirmed = false) {
    setBuildStarting(true);
    setBuildWarning(null);
    try {
      const r = await fetch('/api/setup/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed }) });
      const d = await r.json() as { started?: boolean; warning?: string; areaKm2?: number; error?: string };
      if (r.status === 409 && d.warning) { setBuildWarning({ message: d.warning, areaKm2: d.areaKm2 ?? 0 }); return; }
      if (!r.ok) throw new Error(d.error ?? 'Échec du démarrage');
      setBuildStatus({ status: 'running', startedAt: new Date().toISOString(), step: 'Démarrage…' });
    } catch {
      /* surfaced via buildStatus polling once it exists; nothing more to do here */
    } finally {
      setBuildStarting(false);
    }
  }

  if (!authChecked || loading) return <div className="grid h-screen place-items-center bg-[#07120f] text-sm text-[#8da79d]">Chargement…</div>;

  return (
    <div className="min-h-screen bg-[#07120f] px-4 py-6 text-[#edf5ef] lg:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Configuration de l'instance</h1>
            <p className="text-xs text-[#8da79d]">
              {config?.configured ? `Actuellement configuré pour ${config.countryName}` : 'Instance non configurée'}
            </p>
          </div>
          <a href="/dashboard" className="rounded-lg border border-white/10 bg-[#0b1d18] px-3 py-1.5 text-xs text-[#8da79d] hover:text-[#edf5ef]">← Tableau de bord</a>
        </div>

        {/* Step 1 — Keys */}
        <section className="rounded-2xl border border-white/10 bg-[#0b1d18] p-5">
          <h2 className="mb-1 text-sm font-semibold">1. Clés</h2>
          <p className="mb-4 text-xs text-[#8da79d]">Écrites directement dans .env.local sur le serveur. Elles ne sont jamais renvoyées ni ré-affichées — seul un état "configuré ✓" est montré.</p>
          <div className="space-y-3">
            {KEY_FIELDS.map(field => (
              <div key={field.key}>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-[#8da79d]">{field.label}</label>
                  {secretsConfigured?.[field.key] && !keyInputs[field.key] && <span className="text-xs text-[#63dda0]">configuré ✓</span>}
                </div>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={secretsConfigured?.[field.key] ? '••••••••  (laisser vide pour ne pas changer)' : 'valeur'}
                  value={keyInputs[field.key] ?? ''}
                  onChange={e => setKeyInputs(prev => ({ ...prev, [field.key]: e.target.value }))}
                  className="w-full rounded-lg border border-white/10 bg-[#07130f] px-3 py-2 text-sm outline-none focus:border-[#45d892]/50"
                />
                <a href={field.helpUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-[#4fa3ff] hover:underline">{field.help} →</a>
              </div>
            ))}
          </div>
          <button onClick={saveKeys} disabled={keysSaveState === 'saving'} className="mt-4 rounded-lg bg-[#45d892] px-4 py-2 text-xs font-semibold text-[#062017] disabled:opacity-50">
            {keysSaveState === 'saving' ? 'Enregistrement…' : 'Enregistrer les clés'}
          </button>
          {keysSaveState === 'saved' && <span className="ml-3 text-xs text-[#63dda0]">Enregistré. Un redémarrage du service est nécessaire pour que le moniteur les utilise.</span>}
          {keysSaveState === 'error' && <span className="ml-3 text-xs text-[#ff8b6d]">Échec de l'enregistrement.</span>}
        </section>

        {/* Step 2 — Country */}
        <section className="rounded-2xl border border-white/10 bg-[#0b1d18] p-5">
          <h2 className="mb-1 text-sm font-semibold">2. Pays</h2>
          <p className="mb-4 text-xs text-[#8da79d]">La zone par défaut (étape suivante) est calculée à partir du pays choisi.</p>
          <select
            value={selectedIso2}
            onChange={e => onSelectCountry(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-[#07130f] px-3 py-2 text-sm"
          >
            <option value="">— choisir un pays —</option>
            {countries.map(c => <option key={c.iso2} value={c.iso2}>{c.flag} {c.name}</option>)}
          </select>
          {bboxLookupError && <p className="mt-2 text-xs text-[#f5b942]">{bboxLookupError}</p>}
        </section>

        {/* Step 3 — Zone */}
        <section className="rounded-2xl border border-white/10 bg-[#0b1d18] p-5">
          <h2 className="mb-1 text-sm font-semibold">3. Zone à surveiller</h2>
          <p className="mb-4 text-xs text-[#8da79d]">Ajustez le rectangle sur la carte (coins déplaçables), ou saisissez les valeurs directement.</p>
          <div className="mb-3 h-72 overflow-hidden rounded-xl border border-white/10">
            <BboxMap bbox={bbox} onChange={setBbox} fitToken={fitToken} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <label className="block">Ouest<input type="number" step="0.01" value={bbox.west} onChange={e => setBbox({ ...bbox, west: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-white/10 bg-[#07130f] px-2 py-1.5" /></label>
            <label className="block">Sud<input type="number" step="0.01" value={bbox.south} onChange={e => setBbox({ ...bbox, south: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-white/10 bg-[#07130f] px-2 py-1.5" /></label>
            <label className="block">Est<input type="number" step="0.01" value={bbox.east} onChange={e => setBbox({ ...bbox, east: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-white/10 bg-[#07130f] px-2 py-1.5" /></label>
            <label className="block">Nord<input type="number" step="0.01" value={bbox.north} onChange={e => setBbox({ ...bbox, north: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-white/10 bg-[#07130f] px-2 py-1.5" /></label>
          </div>
        </section>

        {/* Step 4 — Tunables */}
        <section className="rounded-2xl border border-white/10 bg-[#0b1d18] p-5">
          <h2 className="mb-1 text-sm font-semibold">4. Réglages</h2>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-[#8da79d]">Seuil FRP (MW) — puissance radiative à partir de laquelle un signal est considéré intense</label>
              <input type="number" step="1" min="1" value={frpThresholdMw} onChange={e => setFrpThresholdMw(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/10 bg-[#07130f] px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-[#8da79d]">Rayon de proximité (km) — un village à cette distance ou moins est toujours cité, quel que soit le vent</label>
              <input type="number" step="0.5" min="0.5" value={proximityKm} onChange={e => setProximityKm(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/10 bg-[#07130f] px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-[#8da79d]">Jours de source persistante — au-delà, une cellule est traitée comme une torchère/source industrielle et écartée</label>
              <input type="number" step="1" min="1" value={persistentSourceDays} onChange={e => setPersistentSourceDays(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/10 bg-[#07130f] px-3 py-2 text-sm" />
            </div>
          </div>
          <button onClick={saveRegion} disabled={regionSaveState === 'saving' || !selectedIso2} className="mt-4 rounded-lg bg-[#45d892] px-4 py-2 text-xs font-semibold text-[#062017] disabled:opacity-50">
            {regionSaveState === 'saving' ? 'Enregistrement…' : 'Enregistrer la région et les réglages'}
          </button>
          {regionSaveState === 'saved' && <span className="ml-3 text-xs text-[#63dda0]">Enregistré.</span>}
          {regionSaveState === 'error' && <span className="ml-3 text-xs text-[#ff8b6d]">{regionSaveError}</span>}
        </section>

        {/* Region build */}
        <section className="rounded-2xl border border-white/10 bg-[#0b1d18] p-5">
          <h2 className="mb-1 text-sm font-semibold">Générer les données de la région</h2>
          <p className="mb-4 text-xs text-[#8da79d]">
            Récupère les frontières administratives et l'index des villages pour la zone enregistrée ci-dessus (requêtes Overpass/geoBoundaries — peut prendre de quelques secondes à plusieurs minutes selon la taille de la zone).
          </p>

          {buildWarning && (
            <div className="mb-3 rounded-lg border border-[#f5b942]/40 bg-[#f5b942]/10 p-3 text-xs text-[#f7d879]">
              <p className="mb-2">{buildWarning.message}</p>
              <div className="flex gap-2">
                <button onClick={() => startBuild(true)} className="rounded-lg bg-[#f5b942] px-3 py-1.5 font-semibold text-[#241b02]">Lancer quand même</button>
                <button onClick={() => setBuildWarning(null)} className="rounded-lg border border-white/10 px-3 py-1.5 text-[#8da79d]">Annuler</button>
              </div>
            </div>
          )}

          <button
            onClick={() => startBuild(false)}
            disabled={buildStarting || buildStatus?.status === 'running' || !selectedIso2}
            className="rounded-lg bg-[#45d892] px-4 py-2 text-xs font-semibold text-[#062017] disabled:opacity-50"
          >
            {buildStatus?.status === 'running' ? 'Génération en cours…' : 'Générer les données de la région'}
          </button>

          {buildStatus?.status === 'running' && (
            <p className="mt-3 flex items-center gap-2 text-xs text-[#8da79d]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[#45d892]" /> {buildStatus.step}
            </p>
          )}

          {buildStatus?.status === 'success' && (
            <div className="mt-3 rounded-lg border border-[#2a6c53] bg-[#102a21] p-3 text-xs">
              <p className="mb-1 text-[#63dda0]">{buildStatus.villageCount} villages indexés{buildStatus.droppedOutsideBoundary > 0 ? ` (${buildStatus.droppedOutsideBoundary} écartés, hors zone administrative connue)` : ''}.</p>
              {!buildStatus.adminBoundariesOk && (
                <p className="mb-1 text-[#f5b942]">Frontières administratives indisponibles ({buildStatus.adminBoundariesError}) — les alertes n'indiqueront pas de région pour ce pays.</p>
              )}
              {Object.keys(buildStatus.perRegion).length > 0 && (
                <p className="text-[#8da79d]">{Object.entries(buildStatus.perRegion).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r, c]) => `${r}: ${c}`).join(' · ')}</p>
              )}
            </div>
          )}

          {buildStatus?.status === 'error' && (
            <div className="mt-3 rounded-lg border border-[#ff5b32]/40 bg-[#ff5b32]/10 p-3 text-xs text-[#ff8b6d]">
              <p className="mb-2">Échec : {buildStatus.error}</p>
              <p className="mb-2 text-[#8da79d]">Les données précédentes n'ont pas été modifiées — l'instance continue de fonctionner avec elles.</p>
              <button onClick={() => startBuild(false)} className="rounded-lg bg-[#45d892] px-3 py-1.5 font-semibold text-[#062017]">Réessayer</button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
