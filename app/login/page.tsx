'use client';

import { useState } from 'react';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      if (r.ok) { window.location.href = '/dashboard'; return; }
      const data = await r.json().catch(() => ({})) as { error?: string };
      setError(data.error ?? 'Mot de passe incorrect');
    } catch {
      setError('Erreur réseau');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#07120f] px-4 text-[#edf5ef]">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0b1d18] p-6">
        <h1 className="mb-1 text-lg font-semibold">Algérie Feux Alerte</h1>
        <p className="mb-5 text-sm text-[#8da79d]">Accès réservé — tableau de bord de veille</p>
        <label className="mb-1 block text-xs uppercase tracking-wide text-[#8da79d]" htmlFor="password">Mot de passe</label>
        <input
          id="password"
          type="password"
          autoFocus
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border border-white/10 bg-[#07130f] px-3 py-2 text-sm outline-none focus:border-[#45d892]/50"
        />
        {error && <p className="mb-4 text-sm text-[#ff8b6d]">{error}</p>}
        <button type="submit" disabled={busy || !password} className="w-full rounded-lg bg-[#45d892] py-2.5 text-sm font-semibold text-[#062017] disabled:opacity-50">
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </main>
  );
}
