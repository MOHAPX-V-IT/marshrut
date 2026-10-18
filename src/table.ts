import Papa from 'papaparse';

export type ColumnType = 'text' | 'number' | 'date';
export type Dataset = {
  columns: string[];
  rows: string[][];
  types: ColumnType[];
  delimiter: string;
  warnings: string[];
};
export type Filter = {
  id: string;
  column: number;
  op: 'contains' | 'equals' | 'gt' | 'lt' | 'empty' | 'notEmpty';
  value: string;
};
export type Query = {
  search: string;
  filters: Filter[];
  sort: { column: number; direction: 'asc' | 'desc' } | null;
  types: ColumnType[];
};
export type Summary = {
  column: number;
  filled: number;
  invalid: number;
  sum: number | null;
  average: number | null;
  min: number | null;
  max: number | null;
};
export const MAX_BYTES = 50 * 1024 * 1024;
export function detectDelimiter(text: string): string {
  text = text.replace(/^(?:[ \t]*\r?\n)+/, '');
  const candidates = [',', ';', '\t', '|'];
  const counts = new Map(candidates.map((c) => [c, 0]));
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (c === '\n' || c === '\r') break;
      if (counts.has(c)) counts.set(c, counts.get(c)! + 1);
    }
  }
  return candidates.reduce((best, c) => (counts.get(c)! > counts.get(best)! ? c : best), ',');
}
export function numeric(value: string): number | null {
  const v = value
    .trim()
    .replace(/\u00a0/g, '')
    .replace(/\s+/g, '');
  if (!v || !/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(v)) return null;
  const result = Number(v.replace(',', '.'));
  return Number.isFinite(result) ? result : null;
}
export function dateValue(value: string): number | null {
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(v)) return null;
  const day = v.slice(0, 10);
  const n = Date.parse(v);
  if (!Number.isFinite(n)) return null;
  if (new Date(Date.parse(day)).toISOString().slice(0, 10) !== day) return null;
  return n;
}
export function parseCSV(text: string, delimiter = ''): Dataset {
  if (new TextEncoder().encode(text).length > MAX_BYTES)
    throw new Error('Файл больше 50 МБ. Разделите его на части.');
  const sourceText = text.replace(/^\uFEFF/, '');
  const parsed = Papa.parse<string[]>(sourceText, {
    delimiter: delimiter || detectDelimiter(sourceText),
    skipEmptyLines: 'greedy',
  });
  const serious = parsed.errors.find((e) => e.code !== 'UndetectableDelimiter');
  if (serious)
    throw new Error(
      `CSV: ${serious.message}${serious.row !== undefined ? `, запись ${serious.row + 1}` : ''}`,
    );
  if (!parsed.data.length || parsed.data[0].every((c) => !c.trim()))
    throw new Error('Файл пуст. Нужна строка заголовков.');
  const header = parsed.data[0];
  if (header.length > 200) throw new Error('В файле больше 200 столбцов.');
  if (parsed.data.length > 500001) throw new Error('В файле больше 500 000 строк.');
  if ((parsed.data.length - 1) * header.length > 5_000_000)
    throw new Error('В файле больше 5 млн ячеек.');
  const used = new Set<string>();
  const columns = header.map((name, index) => {
    const base = name.trim() || `Столбец ${index + 1}`;
    let next = base;
    let n = 2;
    while (used.has(next)) next = `${base} (${n++})`;
    used.add(next);
    return next;
  });
  const warnings: string[] = [];
  if (columns.some((c, i) => c !== header[i]))
    warnings.push('Пустые или повторяющиеся заголовки получили уникальные имена.');
  const source = parsed.data.slice(1);
  const mismatch = source.findIndex((row) => row.length > columns.length);
  if (mismatch !== -1)
    throw new Error(
      `Запись ${mismatch + 2}: больше значений, чем заголовков. Проверьте разделитель.`,
    );
  const short = source.filter((row) => row.length < columns.length).length;
  if (short) warnings.push(`Короткие записи (${short}) дополнены пустыми ячейками.`);
  const rows = source.map((row) => columns.map((_, index) => row[index] ?? ''));
  const types: ColumnType[] = columns.map((_, col) => {
    const sample = rows
      .slice(0, 1000)
      .map((row) => row[col])
      .filter((s) => s.trim() !== '');
    if (
      sample.length &&
      sample.every((s) => numeric(s) !== null) &&
      !sample.some((s) => /^0\d+/.test(s.trim()))
    )
      return 'number';
    if (sample.length && sample.every((s) => dateValue(s) !== null)) return 'date';
    return 'text';
  });
  return { columns, rows, types, delimiter: parsed.meta.delimiter || ',', warnings };
}
export function safeCell(value: string): string {
  return /^[\s\uFEFF]*[=+\-@\t\r\n]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
}
export function exportCSV(columns: string[], rows: string[][], delimiter = ','): string {
  return (
    '\uFEFF' +
    Papa.unparse([columns.map(safeCell), ...rows.map((row) => row.map(safeCell))], {
      delimiter,
      newline: '\r\n',
      quotes: true,
    })
  );
}
