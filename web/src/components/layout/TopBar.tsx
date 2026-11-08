import { Sun, Moon, Database } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import type { HealthInfo } from '../../lib/api';

export function PilotGlyph({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="shrink-0" aria-hidden="true">
      <defs>
        <linearGradient id="pilot-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366F1" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#pilot-g)" />
      <path d="M9 22.5 L16 8.5 L23 22.5 L16 18.5 Z" fill="white" fillOpacity="0.95" />
    </svg>
  );
}

function demoSources(h: HealthInfo | null, sawSimulated: boolean): string[] {
  if (!h) return [];
  const list: string[] = [];
  if (h.llm === 'mock') list.push('scripted agent (no LLM key)');
  if (h.llm === 'fallback') list.push('scripted agent (LLM unavailable)');
  if (h.paypalMode === 'simulate') list.push('simulated PayPal (PAYPAL_MODE=simulate)');
  else if (h.paypal === 'mock' || sawSimulated) list.push(h.paypalCredentials ? 'simulated PayPal (sandbox unavailable)' : 'simulated PayPal');
  if (h.channel3 === 'mock') list.push('mock product catalog');
  if (h.channel3 === 'fallback') list.push('mock product catalog (Channel3 unavailable)');
  if (h.elastic !== 'configured') list.push(h.elastic === 'fallback' ? 'in-memory transactions (Elastic unavailable)' : 'in-memory transactions');
  return list;
}

export function TopBar({ health, sawSimulated }: { health: HealthInfo | null; sawSimulated: boolean }) {
  const { theme, toggle } = useTheme();
  const sources = demoSources(health, sawSimulated);
  const showBadge = sources.length > 0;

  return (
    <header className="topbar">
      <div className="flex items-center gap-2.5">
        <PilotGlyph />
        <span className="font-semibold text-[15px] tracking-tight" style={{ color: 'var(--text)' }}>Pilot</span>
        <span className="hidden sm:inline text-xs" style={{ color: 'var(--muted)' }}>AI CFO</span>
      </div>

      <div className="flex items-center gap-2">
        {showBadge && (
          <span className="demo-badge" title={sources.length ? `Mocked: ${sources.join(', ')}` : 'Sample transactions, live integrations'}>
            <Database size={11} />
            demo data
          </span>
        )}
        <button onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} className="icon-btn">
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
}
