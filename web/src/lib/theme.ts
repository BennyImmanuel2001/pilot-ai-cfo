import type { AgChartTheme } from 'ag-charts-community';
import { themeQuartz } from 'ag-grid-community';

export type Mode = 'dark' | 'light';

export const FONT = "'Geist Variable', 'Inter', system-ui, sans-serif";

export const COLORS = {
  indigo: '#6366F1',
  cyan: '#22D3EE',
  violet: '#A78BFA',
  sky: '#38BDF8',
  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
};

/** Accent-derived categorical palette, ordered so neighbours stay distinguishable. */
export const PALETTE = ['#6366F1', '#22D3EE', '#A78BFA', '#34D399', '#38BDF8', '#F472B6', '#FBBF24', '#818CF8'];

export function tokens(mode: Mode) {
  return mode === 'dark'
    ? { text: 'rgba(255,255,255,0.92)', muted: 'rgba(255,255,255,0.45)', faint: 'rgba(255,255,255,0.06)', tooltipBg: '#141824', border: 'rgba(255,255,255,0.10)' }
    : { text: 'rgba(10,12,20,0.88)', muted: 'rgba(10,12,20,0.48)', faint: 'rgba(10,12,20,0.06)', tooltipBg: '#FFFFFF', border: 'rgba(10,12,20,0.10)' };
}

export function chartTheme(mode: Mode): AgChartTheme {
  const t = tokens(mode);
  const axis = {
    line: { enabled: false },
    tick: { enabled: false },
    label: { color: t.muted, fontFamily: FONT, fontSize: 11 },
    gridLine: { enabled: true, style: [{ stroke: t.faint, lineDash: [] }] },
    title: { enabled: false },
  };
  return {
    baseTheme: mode === 'dark' ? 'ag-default-dark' : 'ag-default',
    palette: { fills: PALETTE, strokes: PALETTE },
    overrides: {
      common: {
        background: { visible: false },
        padding: { top: 8, right: 8, bottom: 4, left: 4 },
        legend: {
          position: 'bottom',
          spacing: 12,
          item: { label: { color: t.muted, fontFamily: FONT, fontSize: 11 }, marker: { shape: 'circle', size: 8 }, paddingX: 14 },
        },
        axes: {
          category: { ...axis, gridLine: { enabled: false } },
          number: axis,
          time: { ...axis, gridLine: { enabled: false } },
        },
      },
      bar: {
        series: { cornerRadius: 6, strokeWidth: 0 },
      },
      line: {
        series: { strokeWidth: 2.5, marker: { enabled: false } },
      },
      area: {
        series: { strokeWidth: 2.5, fillOpacity: 0.16, interpolation: { type: 'smooth' }, marker: { enabled: false } },
      },
      donut: {
        series: {
          strokeWidth: 2,
          strokes: [mode === 'dark' ? '#0F121A' : '#FFFFFF'],
          calloutLabel: { enabled: false },
          sectorSpacing: 2,
        },
      },
    },
  };
}

export function gridTheme(mode: Mode) {
  const t = tokens(mode);
  return themeQuartz.withParams({
    fontFamily: FONT,
    fontSize: 12.5,
    backgroundColor: 'transparent',
    foregroundColor: t.text,
    textColor: t.text,
    chromeBackgroundColor: 'transparent',
    headerBackgroundColor: 'transparent',
    headerTextColor: t.muted,
    headerFontSize: 11,
    headerFontWeight: 500,
    oddRowBackgroundColor: 'transparent',
    rowHoverColor: mode === 'dark' ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.06)',
    selectedRowBackgroundColor: 'rgba(99,102,241,0.12)',
    borderColor: t.faint,
    wrapperBorder: false,
    headerRowBorder: { color: t.border },
    rowBorder: { color: t.faint },
    columnBorder: false,
    accentColor: COLORS.indigo,
    rowHeight: 36,
    headerHeight: 34,
    spacing: 6,
    cellHorizontalPadding: 14,
    iconSize: 12,
  });
}
