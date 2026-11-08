const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export function formatCurrency(value: number, cents = false): string {
  return (cents ? usd2 : usd0).format(value);
}

export function formatCompactCurrency(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}$${num.format(abs / 1000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

export function formatNumber(value: number): string {
  return num.format(value);
}

/** Parses "YYYY-MM-DD" as a local date (no UTC shift). */
export function parseLocalDate(value: string): Date {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function formatDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  return parseLocalDate(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function titleCase(value: string): string {
  return value.replace(/\b\w/g, c => c.toUpperCase());
}

/** Splits "$1,234.50" or "42%" into prefix, number and suffix so it can be animated. */
export function splitNumeric(value: string): { prefix: string; number: number; suffix: string; decimals: number } | null {
  const m = value.match(/^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/);
  if (!m) return null;
  const raw = m[2].replace(/,/g, '');
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
  return { prefix: m[1], number: n, suffix: m[3], decimals };
}
