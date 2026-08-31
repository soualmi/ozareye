'use client';

import { useEffect, useState } from 'react';
import type { FireEvent } from '@/lib/fire-monitor';
import {
  Activity,
  BellRing,
  Flame,
  MapPin,
  Radio,
  Satellite,
  ShieldCheck,
  Wind,
} from 'lucide-react';

const alerts = [
  {
    place: 'Akfadou · Béjaïa',
    age: 'il y a 8 min',
    score: 87,
    level: 'À vérifier',
    color: '#ff6b35',
  },
  {
    place: 'Yakouren · Tizi Ouzou',
    age: 'il y a 31 min',
    score: 64,
    level: 'Signal détecté',
    color: '#f5b942',
  },
  {
    place: 'El Kala · El Tarf',
    age: 'il y a 1 h 12',
    score: 41,
    level: 'Sous observation',
    color: '#4fa37a',
  },
];

export default function Home() {
  const [signals, setSignals] = useState<FireEvent[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [testState, setTestState] = useState('Envoyer une alerte test');
  useEffect(() => { fetch('/api/fires').then(r => r.json()).then(data => { setSignals(data.signals ?? []); setConfigured(data.configured !== false); }).catch(() => setConfigured(false)); }, []);
  const visibleAlerts = signals.length ? signals.slice(0, 3).map(s => ({place:`${s.latitude.toFixed(3)}, ${s.longitude.toFixed(3)}`,age:new Date(s.lastAcquiredAt).toLocaleString('fr-DZ'),score:s.score,level:s.status === 'urgent' ? 'Priorité élevée' : s.status === 'corroborated' ? 'Signal corroboré' : 'Sous observation',color:s.status === 'urgent' ? '#ff6b35' : s.status === 'corroborated' ? '#f5b942' : '#4fa37a'})) : alerts;
  async function testTelegram(){ setTestState('Envoi…'); const r=await fetch('/api/telegram-test',{method:'POST'}); setTestState(r.ok?'Message envoyé ✓':'Configuration requise'); }
  return (
    <main className="min-h-screen bg-[#07120f] text-[#edf5ef]">
      <header className="border-b border-white/10 bg-[#091814]/95 px-5 py-4 lg:px-8">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#ff5b32] text-white">
              <Flame size={21} />
            </span>
            <div>
              <p className="font-semibold tracking-tight">Algérie Feux Alerte</p>
              <p className="text-xs text-[#8da79d]">
                Veille incendie · Algérie
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-[#45d892]/25 bg-[#45d892]/10 px-3 py-1.5 text-xs text-[#77e7ae]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#45d892]" />
            Surveillance active
          </div>
        </div>
      </header>
      <section className="mx-auto grid max-w-[1500px] gap-4 p-4 lg:grid-cols-[1fr_360px] lg:p-8">
        <div className="space-y-4">
          {configured === false && <div className="rounded-xl border border-[#f5b942]/30 bg-[#f5b942]/10 px-4 py-3 text-sm text-[#f7d879]">Mode démonstration — ajoutez les clés NASA FIRMS et Telegram pour recevoir les données réelles.</div>}
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              icon={<Satellite />}
              label="Pipeline"
              value={configured ? 'Connecté' : 'À configurer'}
              note="NASA VIIRS · Open-Meteo"
            />
            <Metric
              icon={<Activity />}
              label="Signaux enregistrés"
              value={String(signals.length)}
              note="score calculé et traçable"
            />
            <Metric
              icon={<BellRing />}
              label="Collecte"
              value="20 min"
              note="moniteur sécurisé"
            />
          </div>
          <div className="relative min-h-[590px] overflow-hidden rounded-[22px] border border-white/10 bg-[#0b1d18] shadow-2xl">
            <div
              className="absolute inset-0 opacity-20"
              style={{
                backgroundImage:
                  'linear-gradient(#7aa697 1px,transparent 1px),linear-gradient(90deg,#7aa697 1px,transparent 1px)',
                backgroundSize: '44px 44px',
              }}
            />
            <div className="absolute left-5 top-5 z-10 rounded-xl border border-white/10 bg-[#07120f]/85 p-3 backdrop-blur">
              <p className="text-xs uppercase tracking-[.14em] text-[#8da79d]">
                Carte opérationnelle
              </p>
              <p className="mt-1 text-sm font-medium">
                Nord de l’Algérie · dernières 24 h
              </p>
            </div>
            <svg
              viewBox="0 0 900 500"
              className="absolute inset-0 h-full w-full"
              aria-label="Carte schématique des alertes en Algérie"
            >
              <path
                d="M110 113 L204 71 325 89 421 58 535 86 658 73 760 119 726 179 774 240 705 293 652 390 544 424 420 397 325 430 244 368 172 302 190 224 126 185Z"
                fill="#15382c"
                stroke="#527b6c"
                strokeWidth="3"
              />
              <path
                d="M126 185 C250 150 340 179 450 140 S650 142 760 119"
                fill="none"
                stroke="#68a88d"
                strokeOpacity=".55"
                strokeWidth="2"
              />
              <Hotspot x="425" y="103" r="13" />
              <Hotspot x="500" y="112" r="9" />
              <Hotspot x="655" y="121" r="7" />
            </svg>
            <div className="absolute bottom-5 left-5 right-5 z-10 grid gap-2 rounded-xl border border-white/10 bg-[#07120f]/88 p-3 text-xs text-[#a8bdb5] backdrop-blur sm:grid-cols-3">
              <span>● Orange · score élevé</span>
              <span>● Jaune · à corroborer</span>
              <span>● Vert · sous observation</span>
            </div>
          </div>
        </div>
        <aside className="space-y-4">
          <div className="rounded-[22px] border border-white/10 bg-[#0b1d18] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[.14em] text-[#8da79d]">
                  File d’analyse
                </p>
                <h2 className="mt-1 text-lg font-semibold">Alertes récentes</h2>
              </div>
              <span className="rounded-lg bg-[#ff5b32]/15 px-2.5 py-1 text-xs text-[#ff8b6d]">
                3 ouvertes
              </span>
            </div>
            <div className="space-y-3">
              {visibleAlerts.map((a) => (
                <AlertCard key={a.place + a.age} {...a} />
              ))}
            </div>
          </div>
          <div className="rounded-[22px] border border-[#2a6c53] bg-[#102a21] p-5">
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-[#45d892]/15 p-2.5 text-[#63dda0]">
                <Radio size={20} />
              </span>
              <div>
                <h3 className="font-semibold">Alertes Telegram vérifiables</h3>
                <p className="mt-1 text-sm leading-6 text-[#9bb5aa]">
                  Chaque alerte contient les preuves, l’heure d’acquisition et
                  un lien GPS.
                </p>
              </div>
            </div>
            <button onClick={testTelegram} className="mt-4 w-full rounded-xl bg-[#45d892] py-2.5 text-sm font-semibold text-[#062017]">
              {testState}
            </button>
          </div>
        </aside>
      </section>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0b1d18] p-4">
      <div className="mb-4 flex items-center justify-between text-[#63dda0]">
        {icon}
        <span className="text-xs text-[#718d82]">LIVE</span>
      </div>
      <p className="text-sm text-[#9bb5aa]">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-[#718d82]">{note}</p>
    </div>
  );
}
function AlertCard({
  place,
  age,
  score,
  level,
  color,
}: {
  place: string;
  age: string;
  score: number;
  level: string;
  color: string;
}) {
  return (
    <article className="rounded-xl border border-white/10 bg-[#07130f] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 font-medium">
            <MapPin size={14} style={{ color }} />
            {place}
          </p>
          <p className="mt-1 text-xs text-[#718d82]">{age} · VIIRS NOAA-21</p>
        </div>
        <span className="text-lg font-semibold" style={{ color }}>
          {score}
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full"
          style={{ width: `${score}%`, background: color }}
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span style={{ color }}>{level}</span>
        <span className="flex gap-2 text-[#718d82]">
          <Wind size={14} />
          <ShieldCheck size={14} />
        </span>
      </div>
    </article>
  );
}
function Hotspot({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r * 2.2} fill="#ff5b32" opacity=".12" />
      <circle cx={x} cy={y} r={r} fill="#ff5b32" opacity=".9" />
      <circle cx={x} cy={y} r={r / 3} fill="#fff4e9" />
    </g>
  );
}
