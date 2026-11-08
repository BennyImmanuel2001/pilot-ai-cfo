import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { KpiWidget } from '../../spec';
import { COLORS } from '../../lib/theme';
import { CountUp, Sparkline } from './common';

const TREND = {
  up: { Icon: ArrowUpRight, color: COLORS.success, label: 'trending up' },
  down: { Icon: ArrowDownRight, color: COLORS.danger, label: 'trending down' },
  flat: { Icon: Minus, color: 'var(--muted)', label: 'flat' },
} as const;

export function KpiCard({ widget }: { widget: KpiWidget }) {
  const trend = widget.trend && (widget.trend !== 'flat' || widget.delta) ? TREND[widget.trend] : null;
  const sparkColor = widget.trend === 'down' ? COLORS.danger : widget.trend === 'up' ? COLORS.success : COLORS.indigo;

  return (
    <section className="card h-full flex flex-col justify-between p-5 min-h-[120px] sm:min-h-[152px] overflow-hidden" aria-label={widget.title}>
      <div>
        <h3 className="card-title">{widget.title}</h3>
        <p className="kpi-value mt-3" style={{ color: 'var(--text)' }}>
          <CountUp value={widget.value} />
        </p>
        {(widget.delta || trend) && (
          <p className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
            {trend && (
              <span className="trend-dot" style={{ color: trend.color }} aria-label={trend.label}>
                <trend.Icon size={12} strokeWidth={2.5} />
              </span>
            )}
            {widget.delta && <span className="tabular-nums">{widget.delta}</span>}
          </p>
        )}
      </div>
      {widget.sparkline && widget.sparkline.length > 1 && (
        <div className="-mx-5 -mb-5 mt-3">
          <Sparkline values={widget.sparkline} color={sparkColor} />
        </div>
      )}
    </section>
  );
}
