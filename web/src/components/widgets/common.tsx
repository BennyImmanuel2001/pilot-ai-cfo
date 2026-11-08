import { useEffect, useRef, useState, type ReactNode } from 'react';
import { animate } from 'framer-motion';
import { splitNumeric } from '../../lib/format';

export function WidgetCard({ title, action, children, className = '', bodyClassName = '' }: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card h-full flex flex-col ${className}`} aria-label={title}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-5 pt-4">
          {title && <h3 className="card-title">{title}</h3>}
          {action}
        </header>
      )}
      <div className={`flex-1 min-h-0 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Animates the numeric part of a formatted value, e.g. "$1,234" or "42%". */
export function CountUp({ value }: { value: string }) {
  const parts = splitNumeric(value);
  const [display, setDisplay] = useState(parts ? 0 : NaN);
  const prev = useRef(0);

  useEffect(() => {
    if (!parts) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setDisplay(parts.number);
      prev.current = parts.number;
      return;
    }
    const controls = animate(prev.current, parts.number, {
      duration: 0.9,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: v => setDisplay(v),
    });
    prev.current = parts.number;
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  if (!parts) return <>{value}</>;
  const formatted = display.toLocaleString('en-US', {
    minimumFractionDigits: parts.decimals,
    maximumFractionDigits: parts.decimals,
  });
  return <>{parts.prefix}{formatted}{parts.suffix}</>;
}

export function Sparkline({ values, color, height = 36 }: { values: number[]; color: string; height?: number }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = height;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - ((v - min) / range) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const gid = `spark-${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-[120px] flex items-center justify-center text-sm" style={{ color: 'var(--muted)' }}>
      {children}
    </div>
  );
}
