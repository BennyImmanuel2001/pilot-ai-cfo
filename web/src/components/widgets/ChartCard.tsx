import { useMemo } from 'react';
import { AgCharts } from 'ag-charts-react';
import type { AgChartOptions } from 'ag-charts-community';
import type { ChartWidget } from '../../spec';
import { useTheme } from '../../contexts/ThemeContext';
import { chartTheme, tokens } from '../../lib/theme';
import { formatCompactCurrency, formatCurrency, formatNumber, titleCase } from '../../lib/format';
import { EmptyNote, WidgetCard } from './common';

export function ChartCard({ widget }: { widget: ChartWidget }) {
  const { theme } = useTheme();
  const isCurrency = widget.format !== 'number';
  const fmt = (v: number) => (isCurrency ? formatCurrency(v) : formatNumber(v));
  const fmtAxis = (v: number) => (isCurrency ? formatCompactCurrency(v) : formatNumber(v));

  const hasData = widget.categories.length > 0 && (widget.kind === 'donut'
    ? (widget.series[0]?.values ?? []).some(v => Math.abs(v) > 0)
    : widget.series.some(s => s.values.length > 0));

  const options = useMemo<AgChartOptions>(() => {
    const base = { theme: chartTheme(theme), animation: { enabled: true, duration: 600 } };
    const tooltip = (title: (d: Record<string, unknown>) => string, value: (d: Record<string, unknown>) => number) => ({
      renderer: ({ datum }: { datum: Record<string, unknown> }) => ({ title: title(datum), content: fmt(value(datum)) }),
    });

    if (widget.kind === 'donut') {
      const values = widget.series[0]?.values ?? [];
      const data = widget.categories.map((c, i) => ({ label: titleCase(c), value: Math.abs(values[i] ?? 0) }));
      const total = data.reduce((s, d) => s + d.value, 0);
      return {
        ...base,
        data,
        legend: { enabled: true, position: widget.span >= 2 ? 'right' : 'bottom' },
        series: [{
          type: 'donut',
          angleKey: 'value',
          legendItemKey: 'label',
          innerRadiusRatio: 0.7,
          innerLabels: [
            { text: isCurrency ? formatCompactCurrency(total) : formatNumber(total), fontSize: 22, fontWeight: 300, color: tokens(theme).text },
            { text: 'total', fontSize: 11, color: tokens(theme).muted, spacing: 4 },
          ],
          tooltip: tooltip(d => String(d.label), d => Number(d.value)),
        }],
      } as AgChartOptions;
    }

    const data = widget.categories.map((c, i) => {
      const row: Record<string, string | number> = { x: c };
      widget.series.forEach((s, j) => { row[`s${j}`] = s.values[i] ?? 0; });
      return row;
    });
    const multi = widget.series.length > 1;
    const longLabels = widget.kind === 'bar' && widget.categories.length <= 12 && widget.categories.some(c => c.length > 9);
    const series = widget.series.map((s, j) => {
      const common = { xKey: 'x', yKey: `s${j}`, yName: s.name, tooltip: tooltip(d => String(d.x), d => Number(d[`s${j}`])) };
      if (widget.kind === 'bar') return { type: 'bar', ...common, stacked: multi, direction: longLabels ? 'horizontal' : 'vertical' };
      if (widget.kind === 'line') return { type: 'line', ...common, marker: { enabled: widget.categories.length <= 14, size: 6 } };
      return { type: 'area', ...common, stacked: false };
    });

    return {
      ...base,
      data,
      legend: { enabled: multi },
      series,
      axes: [
        { type: 'category', position: longLabels ? 'left' : 'bottom', paddingInner: 0.35 },
        { type: 'number', position: longLabels ? 'bottom' : 'left', label: { formatter: ({ value }: { value: number }) => fmtAxis(value) } },
      ],
    } as AgChartOptions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget, theme]);

  const height = widget.kind === 'donut' ? 260 : 280;

  return (
    <WidgetCard title={widget.title} bodyClassName="px-2 pb-3 pt-1">
      {hasData
        ? <div className="h-full" style={{ minHeight: height }}><AgCharts options={options} style={{ height: '100%', width: '100%' }} /></div>
        : <EmptyNote>No data for this period.</EmptyNote>}
    </WidgetCard>
  );
}
