import { Component, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RefreshCw, ServerCrash } from 'lucide-react';
import type { DashboardSpec, Widget } from '../../spec';
import { KpiCard } from '../widgets/KpiCard';
import { ChartCard } from '../widgets/ChartCard';
import { GridCard } from '../widgets/GridCard';
import { TimelineCard } from '../widgets/TimelineCard';
import { VerdictCard } from '../widgets/VerdictCard';

class WidgetBoundary extends Component<{ title?: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn('Widget failed to render', err);
  }
  render() {
    if (this.state.failed) {
      return (
        <section className="card h-full p-5 flex items-center justify-center text-sm" style={{ color: 'var(--muted)' }}>
          {this.props.title ? `"${this.props.title}" couldn't be drawn.` : "This widget couldn't be drawn."}
        </section>
      );
    }
    return this.props.children;
  }
}

function renderWidget(w: Widget) {
  switch (w.type) {
    case 'kpi': return <KpiCard widget={w} />;
    case 'chart': return <ChartCard widget={w} />;
    case 'grid': return <GridCard widget={w} />;
    case 'timeline': return <TimelineCard widget={w} />;
    case 'verdict': return <VerdictCard widget={w} />;
  }
}

const SKELETON_SPANS = [1, 1, 1, 1, 2, 2, 4];

function SkeletonGrid() {
  return (
    <div className="bento" aria-busy="true" aria-label="Loading dashboard">
      {SKELETON_SPANS.map((span, i) => (
        <div key={i} className={`card span-${span} p-5 flex flex-col gap-4`} style={{ minHeight: span === 1 ? 152 : span === 4 ? 260 : 320 }}>
          <div className="skeleton h-3 w-24" />
          <div className={`skeleton ${span === 1 ? 'h-9 w-32' : 'flex-1 w-full'}`} />
          {span === 1 && <div className="skeleton h-3 w-20" />}
        </div>
      ))}
    </div>
  );
}

interface Props {
  spec: DashboardSpec | null;
  specKey: number;
  isLoading: boolean;
  failed: boolean;
  onRetry: () => void;
}

export function DashboardPanel({ spec, specKey, isLoading, failed, onRetry }: Props) {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden" id="dashboard">
      <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <AnimatePresence mode="wait">
          {spec && !isLoading && (
            <motion.header
              key={`h-${specKey}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.25 }}
              className="mb-5"
            >
              <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight" style={{ color: 'var(--text)' }}>{spec.title}</h1>
              {spec.subtitle && <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>{spec.subtitle}</p>}
            </motion.header>
          )}
        </AnimatePresence>

        {isLoading ? (
          <>
            <div className="mb-5"><div className="skeleton h-7 w-56" /><div className="skeleton h-3.5 w-40 mt-2.5" /></div>
            <SkeletonGrid />
          </>
        ) : failed && !spec ? (
          <div className="card p-10 flex flex-col items-center text-center gap-3 max-w-md mx-auto mt-16">
            <ServerCrash size={28} style={{ color: 'var(--muted)' }} />
            <h2 className="font-semibold" style={{ color: 'var(--text)' }}>Can't reach the Pilot server</h2>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>Start it with <code className="mono">npm run dev</code> from the repo root, then retry.</p>
            <button className="btn-secondary mt-2" onClick={onRetry}><RefreshCw size={13} /> Retry</button>
          </div>
        ) : spec ? (
          <div className="bento">
            <AnimatePresence mode="popLayout">
              {spec.widgets.map((w, i) => (
                <motion.div
                  key={`${specKey}-${w.id ?? i}`}
                  layout
                  className={`span-${w.span} min-w-0`}
                  initial={{ opacity: 0, y: 24, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 26, delay: i * 0.06 } }}
                  exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.18 } }}
                >
                  <WidgetBoundary title={'title' in w ? w.title : undefined}>{renderWidget(w)}</WidgetBoundary>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ) : null}
      </div>
    </div>
  );
}
