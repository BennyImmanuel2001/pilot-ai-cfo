import { useMemo } from 'react';
import { AgCharts } from 'ag-charts-react';
import type { AgChartOptions } from 'ag-charts-community';
import type { TimelineWidget } from '../../spec';
import { useTheme } from '../../contexts/ThemeContext';
import { chartTheme, COLORS, tokens } from '../../lib/theme';
import { formatCompactCurrency, formatCurrency, parseLocalDate } from '../../lib/format';
import { EmptyNote, WidgetCard } from './common';

export function TimelineCard({ widget }: { widget: TimelineWidget }) {
  const { theme } = useTheme();

  const { options, lowest, end } = useMemo(() => {
    const points = widget.points.map(p => ({ date: parseLocalDate(p.date), balance: p.balance }));
    const byDate = new Map(widget.points.map(p => [p.date, p.balance]));
    const events = widget.events.map(e => ({
      date: parseLocalDate(e.date),
      balance: byDate.get(e.date) ?? points[0]?.balance ?? 0,
      label: e.label,
      amount: e.amount,
    }));
    const lowestPoint = points.reduce((m, p) => (p.balance < m ? p.balance : m), Infinity);
    const endBalance = points[points.length - 1]?.balance ?? 0;
    const belowSafety = widget.safetyLine !== undefined && lowestPoint < widget.safetyLine;
    const lineColor = belowSafety ? COLORS.danger : COLORS.indigo;
    const t = tokens(theme);

    const opts = {
      theme: chartTheme(theme),
      legend: { enabled: false },
      series: [
        {
          type: 'area',
          data: points,
          xKey: 'date',
          yKey: 'balance',
          yName: 'Balance',
          fill: lineColor,
          stroke: lineColor,
          tooltip: {
            renderer: ({ datum }: { datum: { date: Date; balance: number } }) => ({
              title: datum.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
              content: `Balance ${formatCurrency(datum.balance)}`,
            }),
          },
        },
        {
          type: 'scatter',
          data: events,
          xKey: 'date',
          yKey: 'balance',
          yName: 'Events',
          marker: { size: 11, shape: 'circle', fill: theme === 'dark' ? '#0B0D12' : '#FFFFFF', stroke: COLORS.cyan, strokeWidth: 2.5 },
          label: {
            enabled: events.length <= 8,
            placement: 'top',
            color: t.muted,
            fontSize: 10,
            formatter: ({ datum }: { datum: { label: string } }) => datum.label.length > 16 ? `${datum.label.slice(0, 15)}…` : datum.label,
          },
          tooltip: {
            renderer: ({ datum }: { datum: { date: Date; label: string; amount: number } }) => ({
              title: datum.label,
              content: `${datum.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${formatCurrency(datum.amount, true)}`,
            }),
          },
        },
      ],
      axes: [
        { type: 'time', position: 'bottom', nice: false, label: { format: '%b %e' } },
        {
          type: 'number',
          position: 'left',
          label: { formatter: ({ value }: { value: number }) => formatCompactCurrency(value) },
          crossLines: widget.safetyLine !== undefined
            ? [{
                type: 'line',
                value: widget.safetyLine,
                stroke: COLORS.danger,
                strokeWidth: 1.5,
                lineDash: [6, 5],
                strokeOpacity: 0.85,
                label: { text: `Safety ${formatCompactCurrency(widget.safetyLine)}`, position: 'topRight', color: COLORS.danger, fontSize: 10 },
              }]
            : [],
        },
      ],
    } as unknown as AgChartOptions;

    return { options: opts, lowest: lowestPoint, end: endBalance };
  }, [widget, theme]);

  const legend = (
    <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--muted)' }}>
      <span className="hidden sm:inline tabular-nums">Low {formatCurrency(Number.isFinite(lowest) ? lowest : 0)}</span>
      <span className="tabular-nums">End {formatCurrency(end)}</span>
    </div>
  );

  return (
    <WidgetCard title={widget.title} action={legend} bodyClassName="px-2 pb-3 pt-1">
      {widget.points.length > 1
        ? <div className="h-full" style={{ minHeight: 300 }}><AgCharts options={options} style={{ height: '100%', width: '100%' }} /></div>
        : <EmptyNote>Not enough days left in the month to project.</EmptyNote>}
    </WidgetCard>
  );
}
