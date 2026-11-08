import { z } from 'zod';

// Mirror of server/src/spec.ts — keep in sync
const SpanSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1);

export const KpiWidget = z.object({
  type: z.literal('kpi'),
  id: z.string().optional(),
  title: z.string(),
  value: z.string(),
  delta: z.string().optional(),
  trend: z.enum(['up', 'down', 'flat']).optional(),
  sparkline: z.array(z.number()).optional(),
  span: SpanSchema,
});

export const ChartWidget = z.object({
  type: z.literal('chart'),
  id: z.string().optional(),
  title: z.string(),
  kind: z.enum(['bar', 'line', 'area', 'donut']),
  categories: z.array(z.string()),
  series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })),
  format: z.enum(['currency', 'number']).optional(),
  span: SpanSchema.default(2),
});

export const GridWidget = z.object({
  type: z.literal('grid'),
  id: z.string().optional(),
  title: z.string(),
  columns: z.array(z.object({
    field: z.string(),
    headerName: z.string(),
    type: z.enum(['currency', 'date', 'text']).optional(),
  })),
  rows: z.array(z.record(z.unknown())),
  groupBy: z.array(z.string()).optional(),
  pivot: z.boolean().optional(),
  span: SpanSchema.default(4),
});

export const TimelineWidget = z.object({
  type: z.literal('timeline'),
  id: z.string().optional(),
  title: z.string(),
  points: z.array(z.object({ date: z.string(), balance: z.number() })),
  events: z.array(z.object({ date: z.string(), label: z.string(), amount: z.number() })),
  safetyLine: z.number().optional(),
  span: SpanSchema.default(4),
});

export const VerdictWidget = z.object({
  type: z.literal('verdict'),
  id: z.string().optional(),
  title: z.string().optional(),
  item: z.object({
    title: z.string(),
    price: z.number(),
    image: z.string().optional(),
    retailer: z.string().optional(),
  }),
  decision: z.enum(['yes', 'wait', 'no']),
  reasoning: z.array(z.string()),
  endOfMonthBalance: z.number(),
  actionId: z.string().optional(),
  span: SpanSchema.default(2),
});

export const Widget = z.discriminatedUnion('type', [
  KpiWidget, ChartWidget, GridWidget, TimelineWidget, VerdictWidget,
]);

export const DashboardSpec = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  widgets: z.array(Widget),
});

export type DashboardSpec = z.infer<typeof DashboardSpec>;
export type Widget = z.infer<typeof Widget>;
export type KpiWidget = z.infer<typeof KpiWidget>;
export type ChartWidget = z.infer<typeof ChartWidget>;
export type GridWidget = z.infer<typeof GridWidget>;
export type TimelineWidget = z.infer<typeof TimelineWidget>;
export type VerdictWidget = z.infer<typeof VerdictWidget>;
