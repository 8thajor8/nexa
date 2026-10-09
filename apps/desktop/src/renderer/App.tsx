import { useMemo, useState, useSyncExternalStore } from "react";
import { ASSISTANT_STATE_LABELS, createMockAssistantStateProvider } from "../shared/assistant-state";

const stateStyles = {
  idle: "border-slate-700 bg-slate-900 text-slate-200",
  listening: "border-cyan-700 bg-cyan-950 text-cyan-200",
  thinking: "border-blue-700 bg-blue-950 text-blue-200",
  executing: "border-violet-700 bg-violet-950 text-violet-200",
  speaking: "border-teal-700 bg-teal-950 text-teal-200",
  error: "border-rose-700 bg-rose-950 text-rose-200",
} as const;

export default function App() {
  const stateProvider = useMemo(() => createMockAssistantStateProvider(), []);
  const assistantState = useSyncExternalStore(
    stateProvider.subscribe, stateProvider.getSnapshot, stateProvider.getSnapshot,
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function checkElectronBridge() {
    setBusy(true);
    setError(null);
    setResult(null);
    stateProvider.setState("thinking");
    try {
      stateProvider.setState("executing");
      const response = await window.nexaDesktop.ping();
      setResult(response.message);
      stateProvider.setState("speaking");
      window.setTimeout(() => stateProvider.setState("idle"), 700);
    } catch {
      setError("No se pudo completar la comprobación local.");
      stateProvider.setState("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-8 py-10 text-slate-100">
      <section className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-3xl flex-col justify-center gap-8">
        <header className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">Nexa Desktop</p>
          <h1 className="text-4xl font-semibold tracking-tight">Fundaciones de escritorio</h1>
          <p className="max-w-xl text-sm leading-6 text-slate-400">
            Aplicación local en modo de prueba. El motor Nexa y sus herramientas todavía no están conectados.
          </p>
        </header>
        <section aria-label="Estado del asistente" className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-black/20">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-slate-500">Estado simulado</p>
              <p className="mt-2 text-lg font-medium">{ASSISTANT_STATE_LABELS[assistantState]}</p>
            </div>
            <span className={"inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm " + stateStyles[assistantState]} aria-live="polite" data-testid="assistant-state">
              <span className="h-2 w-2 rounded-full bg-current" />
              {assistantState}
            </span>
          </div>
          <div className="mt-6 border-t border-slate-800 pt-5">
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Aplicación funcionando
            </div>
            <p className="mt-2 text-sm text-slate-400">
              El proveedor de estado es simulado y no realiza llamadas a OpenAI.
            </p>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button type="button" onClick={checkElectronBridge} disabled={busy} className="rounded-lg bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-200 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:cursor-wait disabled:opacity-60">
              {busy ? "Comprobando…" : "Probar conexión segura"}
            </button>
            {result && <span className="text-sm text-emerald-300" role="status">Respuesta local recibida: {result}</span>}
            {error && <span className="text-sm text-rose-300" role="alert">{error}</span>}
          </div>
        </section>
        <footer className="text-xs text-slate-600">UI-01 · IPC local de prueba · Sin conexión con el motor</footer>
      </section>
    </main>
  );
}