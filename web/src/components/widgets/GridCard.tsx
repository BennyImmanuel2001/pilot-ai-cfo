import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams, ValueFormatterParams, RowClassParams } from 'ag-grid-community';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { GridWidget } from '../../spec';
import { useTheme } from '../../contexts/ThemeContext';
import { gridTheme } from '../../lib/theme';
import { formatCurrency, formatDate, titleCase } from '../../lib/format';
import { EmptyNote, WidgetCard } from './common';

type Row = Record<string, unknown>;
interface GroupRow { __group: true; key: string; count: number; total: number; open: boolean }

const PILL_FIELDS = new Set(['category', 'method', 'cadence']);

function PillCell({ value }: ICellRendererParams) {
  if (value === null || value === undefined || value === '') return null;
  const label = String(value).toLowerCase() === 'paypal' ? 'PayPal' : titleCase(String(value));
  return <span className={`cell-pill pill-${String(value).replace(/\s+/g, '-').toLowerCase()}`}>{label}</span>;
}

export function GridCard({ widget }: { widget: GridWidget }) {
  const { theme } = useTheme();
  const textCols = widget.columns.filter(c => (c.type ?? 'text') === 'text' && widget.rows.some(r => typeof r[c.field] === 'string'));
  const dateCol = widget.columns.find(c => c.type === 'date');
  const moneyCol = widget.columns.find(c => c.type === 'currency');
  const canPivot = !!(dateCol && moneyCol && textCols.length);

  const [groupBy, setGroupBy] = useState<string | null>(widget.groupBy?.[0] ?? null);
  const [pivot, setPivot] = useState<boolean>(!!widget.pivot && canPivot);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const gridThemeObj = useMemo(() => gridTheme(theme), [theme]);

  const baseCols = useMemo<ColDef[]>(() => widget.columns.map(c => {
    const col: ColDef = { field: c.field, headerName: c.headerName, sortable: true, resizable: true, flex: 1, minWidth: 90 };
    if (c.type === 'currency') {
      col.type = 'rightAligned';
      col.valueFormatter = (p: ValueFormatterParams) => (typeof p.value === 'number' ? formatCurrency(p.value, true) : '');
      col.cellClassRules = { 'cell-negative': p => typeof p.value === 'number' && p.value < 0, 'cell-positive': p => typeof p.value === 'number' && p.value > 0 };
      col.cellClass = 'tabular-nums';
      col.maxWidth = 160;
    } else if (c.type === 'date') {
      col.valueFormatter = (p: ValueFormatterParams) => (typeof p.value === 'string' ? formatDate(p.value) : String(p.value ?? ''));
      col.cellClass = 'tabular-nums';
      col.maxWidth = 130;
      col.sort = 'desc';
    } else if (PILL_FIELDS.has(c.field)) {
      col.cellRenderer = PillCell;
    } else if (c.field === 'merchant' || c.field === 'label') {
      col.flex = 1.6;
      col.cellClass = 'cell-strong';
    }
    return col;
  }), [widget.columns]);

  // Pivot: rows = group values, columns = months, values = sum of the currency column
  const pivotView = useMemo(() => {
    if (!pivot || !dateCol || !moneyCol) return null;
    const key = groupBy ?? textCols[0].field;
    const months = Array.from(new Set(widget.rows.map(r => String(r[dateCol.field] ?? '').slice(0, 7)))).filter(Boolean).sort();
    const agg = new Map<string, Record<string, number>>();
    for (const r of widget.rows) {
      const g = String(r[key] ?? '—');
      const m = String(r[dateCol.field] ?? '').slice(0, 7);
      const v = Number(r[moneyCol.field]) || 0;
      const rec = agg.get(g) ?? {};
      rec[m] = (rec[m] ?? 0) + v;
      rec.__total = (rec.__total ?? 0) + v;
      agg.set(g, rec);
    }
    const money = (p: ValueFormatterParams) => (typeof p.value === 'number' ? formatCurrency(p.value) : '');
    const cols: ColDef[] = [
      { field: '__key', headerName: titleCase(key), pinned: 'left', cellRenderer: PillCell, minWidth: 130 },
      ...months.map(m => ({
        field: m,
        headerName: new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1).toLocaleString('en-US', { month: 'short' }),
        type: 'rightAligned', valueFormatter: money, cellClass: 'tabular-nums', minWidth: 80, flex: 1,
        cellClassRules: { 'cell-negative': (p: { value: unknown }) => typeof p.value === 'number' && p.value < 0 },
      } as ColDef)),
      { field: '__total', headerName: 'Total', type: 'rightAligned', valueFormatter: money, cellClass: 'tabular-nums cell-strong', minWidth: 100, sort: 'asc' },
    ];
    const rows = Array.from(agg.entries()).map(([k, rec]) => ({ __key: k, ...rec }));
    return { cols, rows };
  }, [pivot, groupBy, widget.rows, dateCol, moneyCol, textCols]);

  // Grouping in code (AG Grid row grouping is an Enterprise feature)
  const rowData = useMemo<(Row | GroupRow)[]>(() => {
    if (!groupBy) return widget.rows;
    const groups = new Map<string, Row[]>();
    for (const r of widget.rows) {
      const k = String(r[groupBy] ?? '—');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    const out: (Row | GroupRow)[] = [];
    const sumOf = (rows: Row[]) => (moneyCol ? rows.reduce((s, r) => s + (Number(r[moneyCol.field]) || 0), 0) : 0);
    const ordered = Array.from(groups.entries()).sort((a, b) => (moneyCol ? sumOf(a[1]) - sumOf(b[1]) : a[0].localeCompare(b[0])));
    for (const [k, rows] of ordered) {
      const open = !closed.has(k);
      out.push({ __group: true, key: k, count: rows.length, total: sumOf(rows), open });
      if (open) out.push(...rows);
    }
    return out;
  }, [groupBy, widget.rows, closed, moneyCol]);

  const toggleGroup = (k: string) =>
    setClosed(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const GroupRenderer = (p: ICellRendererParams) => {
    const g = p.data as GroupRow;
    return (
      <button className="group-row" onClick={() => toggleGroup(g.key)} aria-expanded={g.open}>
        {g.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">{titleCase(g.key)}</span>
        <span className="group-count">{g.count}</span>
        {moneyCol && <span className={`ml-auto tabular-nums ${g.total < 0 ? 'text-negative' : ''}`}>{formatCurrency(g.total, true)}</span>}
      </button>
    );
  };

  const controls = (textCols.length > 0 || canPivot) && widget.rows.length > 0 ? (
    <div className="flex items-center gap-1.5 flex-wrap justify-end">
      {textCols.length > 0 && (
        <div className="seg" role="group" aria-label="Group rows by">
          <button className={!groupBy ? 'on' : ''} onClick={() => setGroupBy(null)}>All</button>
          {textCols.slice(0, 3).map(c => (
            <button key={c.field} className={groupBy === c.field ? 'on' : ''} onClick={() => setGroupBy(c.field)}>{c.headerName}</button>
          ))}
        </div>
      )}
      {canPivot && (
        <button className={`seg-solo ${pivot ? 'on' : ''}`} onClick={() => setPivot(p => !p)} aria-pressed={pivot}>Pivot</button>
      )}
    </div>
  ) : null;

  const visibleCount = pivotView ? pivotView.rows.length : rowData.length;
  const height = Math.min(Math.max(visibleCount, 3) * 36 + 40, 440);

  return (
    <WidgetCard title={widget.title} action={controls} bodyClassName="px-2 pb-2 pt-2">
      {widget.rows.length === 0 ? (
        <EmptyNote>No rows to show.</EmptyNote>
      ) : (
        <div style={{ height }}>
          {pivotView ? (
            <AgGridReact theme={gridThemeObj} rowData={pivotView.rows} columnDefs={pivotView.cols} suppressCellFocus animateRows />
          ) : (
            <AgGridReact
              theme={gridThemeObj}
              rowData={rowData}
              columnDefs={baseCols}
              suppressCellFocus
              animateRows
              isFullWidthRow={p => !!(p.rowNode.data as GroupRow | undefined)?.__group}
              fullWidthCellRenderer={GroupRenderer}
              getRowClass={(p: RowClassParams) => ((p.data as GroupRow | undefined)?.__group ? 'row-group' : undefined)}
              suppressMovableColumns
            />
          )}
        </div>
      )}
    </WidgetCard>
  );
}
