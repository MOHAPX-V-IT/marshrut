import { z } from 'zod';
import { dateValue, numeric, parseCSV, MAX_BYTES } from './table';
import type { ColumnType } from './table';

const name = z.string().min(1).max(160);
const metricSchema = z.object({
  op: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  column: z.string().max(160),
  alias: name,
});
export const configSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), fileId: z.string().max(160) }),
  z.object({
    kind: z.literal('filter'),
    column: z.string().max(160),
    op: z.enum(['contains', 'equals', 'gt', 'lt', 'empty', 'notEmpty']),
    value: z.string().max(10000),
    type: z.enum(['text', 'number', 'date']),
  }),
  z.object({ kind: z.literal('select'), columns: z.array(name).max(200) }),
  z.object({
    kind: z.literal('aggregate'),
    groupBy: z.array(name).max(20),
    metrics: z.array(metricSchema).min(1).max(20),
    invalid: z.enum(['reject', 'skip']),
  }),
  z.object({ kind: z.literal('export'), filename: name, delimiter: z.enum([',', ';', '\t', '|']) }),
]);
export const graphSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(120),
  nodes: z
    .array(
      z.object({
        id: name,
        label: name,
        position: z.object({
          x: z.number().finite().min(-100000).max(100000),
          y: z.number().finite().min(-100000).max(100000),
        }),
        config: configSchema,
      }),
    )
    .max(40),
  edges: z.array(z.object({ id: name, source: name, target: name })).max(120),
});
export type Config = z.infer<typeof configSchema>;
export type Graph = z.infer<typeof graphSchema>;
export type Step = Graph['nodes'][number];
export type SourceFile = {
  id: string;
  name: string;
  text: string;
  delimiter: string;
  columns: string[];
  count: number;
};
export type Sources = Record<string, SourceFile>;
export type Table = { columns: string[]; rows: string[][]; types: ColumnType[] };
export type Issue = { nodeId?: string; message: string };
export type StepResult = {
  nodeId: string;
  status: 'success' | 'error' | 'skipped';
  columns: string[];
  types: ColumnType[];
  count: number;
  preview: string[][];
  ms: number;
  error?: string;
  warnings: string[];
};
export type Execution = { results: StepResult[]; tables: Map<string, Table>; ms: number };
export function restoreSources(value: unknown): Sources {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const files: Sources = Object.create(null);
  for (const [id, unknownFile] of Object.entries(value)) {
    if (typeof unknownFile !== 'object' || unknownFile === null || Array.isArray(unknownFile))
      continue;
    const file = unknownFile as Record<string, unknown>;
    if (typeof file.text !== 'string' || file.text.length > MAX_BYTES) continue;
    files[id] = {
      id,
      name: typeof file.name === 'string' ? file.name : 'Восстановленный.csv',
      text: file.text,
      delimiter:
        typeof file.delimiter === 'string' && ['', ',', ';', '\t', '|'].includes(file.delimiter)
          ? file.delimiter
          : '',
      columns:
        Array.isArray(file.columns) &&
        file.columns.length <= 200 &&
        file.columns.every((c) => typeof c === 'string')
          ? [...file.columns]
          : [],
      count:
        typeof file.count === 'number' &&
        Number.isInteger(file.count) &&
        file.count >= 0 &&
        file.count <= 500000
          ? file.count
          : 0,
    };
  }
  return files;
}
export function parseGraph(text: string): Graph {
  if (text.length > 1_000_000) throw new Error('Схема больше 1 МБ.');
  const result = graphSchema.safeParse(JSON.parse(text));
  if (!result.success)
    throw new Error(
      `Неверный формат схемы: ${result.error.issues[0].path.join('.')} — ${result.error.issues[0].message}`,
    );
  return result.data;
}
export function validateGraph(graph: Graph): Issue[] {
  const issues: Issue[] = [];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  if (nodes.size !== graph.nodes.length)
    issues.push({ message: 'Идентификаторы шагов повторяются.' });
  if (!graph.nodes.some((n) => n.config.kind === 'source'))
    issues.push({ message: 'Добавьте источник CSV.' });
  if (!graph.nodes.some((n) => n.config.kind === 'export'))
    issues.push({ message: 'Добавьте шаг выгрузки.' });
  if (new Set(graph.edges.map((e) => e.id)).size !== graph.edges.length)
    issues.push({ message: 'Идентификаторы связей повторяются.' });
  for (const edge of graph.edges) {
    const from = nodes.get(edge.source);
    const to = nodes.get(edge.target);
    const key = `${edge.source}\u0000${edge.target}`;
    if (!from || !to) {
      issues.push({ message: 'Связь ссылается на отсутствующий шаг.' });
      continue;
    }
    if (edge.source === edge.target)
      issues.push({ nodeId: edge.target, message: 'Нельзя соединить шаг с самим собой.' });
    if (seen.has(key))
      issues.push({ nodeId: edge.target, message: 'Повторяющаяся связь между шагами.' });
    seen.add(key);
    if (from.config.kind === 'export' || to.config.kind === 'source')
      issues.push({
        nodeId: edge.target,
        message: 'Несовместимые порты: выгрузка завершает маршрут, источник его начинает.',
      });
  }
  for (const node of graph.nodes) {
    const incoming = graph.edges.filter((e) => e.target === node.id).length;
    if (node.config.kind === 'source' && incoming > 0)
      issues.push({ nodeId: node.id, message: 'Источник не принимает входящие связи.' });
    else if (node.config.kind !== 'source' && incoming !== 1)
      issues.push({
        nodeId: node.id,
        message:
          incoming === 0
            ? 'Подключите входную таблицу.'
            : 'Шаг принимает ровно одну входную таблицу. Объединение таблиц не поддерживается.',
      });
  }
  if (topologicalOrder(graph).length !== graph.nodes.length)
    issues.push({ message: 'В маршруте есть цикл. Удалите обратную связь.' });
  return issues;
}
export function topologicalOrder(graph: Graph): string[] {
  const degree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const next = new Map(graph.nodes.map((n) => [n.id, [] as string[]]));
  for (const edge of graph.edges) {
    if (!degree.has(edge.source) || !degree.has(edge.target)) continue;
    degree.set(edge.target, degree.get(edge.target)! + 1);
    next.get(edge.source)!.push(edge.target);
  }
  const queue = [...degree].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    order.push(id);
    for (const target of next.get(id)!) {
      const value = degree.get(target)! - 1;
      degree.set(target, value);
      if (!value) queue.push(target);
    }
  }
  return order;
}
export function canConnect(graph: Graph, source: string, target: string): boolean {
  const from = graph.nodes.find((n) => n.id === source);
  const to = graph.nodes.find((n) => n.id === target);
  if (
    !from ||
    !to ||
    source === target ||
    from.config.kind === 'export' ||
    to.config.kind === 'source' ||
    graph.edges.some((e) => e.target === target)
  )
    return false;
  const candidate = { ...graph, edges: [...graph.edges, { id: 'candidate', source, target }] };
  return topologicalOrder(candidate).length === graph.nodes.length;
}
function columnIndex(table: Table, column: string): number {
  const i = table.columns.indexOf(column);
  if (i < 0)
    throw new Error(`Столбец «${column || '(не выбран)'}» отсутствует во входной таблице.`);
  return i;
}
export function transform(
  input: Table,
  config: Exclude<Config, { kind: 'source' }>,
): { table: Table; warnings: string[] } {
  if (config.kind === 'export') return { table: input, warnings: [] };
  if (config.kind === 'select') {
    if (!config.columns.length) throw new Error('Выберите хотя бы один столбец.');
    if (new Set(config.columns).size !== config.columns.length)
      throw new Error('Выбранные столбцы повторяются.');
    const indices = config.columns.map((c) => columnIndex(input, c));
    return {
      table: {
        columns: config.columns,
        types: indices.map((i) => input.types[i]),
        rows: input.rows.map((row) => indices.map((i) => row[i])),
      },
      warnings: [],
    };
  }
  if (config.kind === 'filter') {
    const col = columnIndex(input, config.column);
    const valueOf = (v: string) =>
      config.type === 'number'
        ? numeric(v)
        : config.type === 'date'
          ? dateValue(v)
          : v.toLocaleLowerCase('ru');
    const value = valueOf(config.value);
    if (!['contains', 'empty', 'notEmpty'].includes(config.op) && value === null)
      throw new Error('Значение условия не соответствует выбранному типу.');
    const rows = input.rows.filter((row) => {
      const raw = row[col];
      if (config.op === 'empty') return raw.trim() === '';
      if (config.op === 'notEmpty') return raw.trim() !== '';
      if (config.op === 'contains')
        return raw.toLocaleLowerCase('ru').includes(config.value.toLocaleLowerCase('ru'));
      const cell = valueOf(raw);
      if (cell === null || value === null) return false;
      if (config.op === 'equals') return cell === value;
      return config.op === 'gt' ? cell > value : cell < value;
    });
    return { table: { ...input, rows }, warnings: [] };
  }
  const groupIndices = config.groupBy.map((c) => columnIndex(input, c));
  if (new Set(config.groupBy).size !== config.groupBy.length)
    throw new Error('Поля группировки повторяются.');
  const columns = [...config.groupBy, ...config.metrics.map((m) => m.alias)];
  if (new Set(columns).size !== columns.length)
    throw new Error('Имена выходных столбцов должны быть уникальными.');
  const indices = config.metrics.map((m) =>
    m.op === 'count' && !m.column ? -1 : columnIndex(input, m.column),
  );
  type Acc = { values: string[]; metrics: { n: number; sum: number; min: number; max: number }[] };
  const create = (values: string[]): Acc => ({
    values,
    metrics: config.metrics.map(() => ({ n: 0, sum: 0, min: Infinity, max: -Infinity })),
  });
  const groups = new Map<string, Acc>();
  let invalid = 0;
  if (!groupIndices.length) groups.set('[]', create([]));
  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex++) {
    const row = input.rows[rowIndex];
    const values = groupIndices.map((i) => row[i]);
    const key = JSON.stringify(values);
    let group = groups.get(key);
    if (!group) {
      group = create(values);
      groups.set(key, group);
    }
    config.metrics.forEach((metric, i) => {
      const acc = group!.metrics[i];
      const raw = indices[i] === -1 ? '' : row[indices[i]];
      if (metric.op === 'count') {
        if (indices[i] === -1 || raw.trim() !== '') acc.n++;
        return;
      }
      if (!raw.trim()) return;
      const value = numeric(raw);
      if (value === null) {
        if (config.invalid === 'reject')
          throw new Error(
            `Строка ${rowIndex + 1}, «${metric.column}»: «${raw.slice(0, 40)}» не является числом.`,
          );
        invalid++;
        return;
      }
      acc.n++;
      acc.sum += value;
      acc.min = Math.min(acc.min, value);
      acc.max = Math.max(acc.max, value);
    });
  }
  const rows = [...groups.values()].map((group) => [
    ...group.values,
    ...group.metrics.map((m, i) => {
      const op = config.metrics[i].op;
      if (op === 'count') return String(m.n);
      if (!m.n) return '';
      const value =
        op === 'sum' ? m.sum : op === 'avg' ? m.sum / m.n : op === 'min' ? m.min : m.max;
      if (!Number.isFinite(value)) throw new Error('Числовое переполнение при агрегации.');
      return String(value);
    }),
  ]);
  return {
    table: {
      columns,
      rows,
      types: [
        ...groupIndices.map((i) => input.types[i]),
        ...config.metrics.map(() => 'number' as const),
      ],
    },
    warnings: invalid ? [`Пропущено некорректных числовых значений: ${invalid}.`] : [],
  };
}
export function runGraph(
  graph: Graph,
  sources: Sources,
  onStep?: (result: StepResult) => void,
): Execution {
  const issues = validateGraph(graph);
  if (issues.length) throw new Error(issues.map((i) => i.message).join(' '));
  const fileIds = new Set(
    graph.nodes.flatMap((node) => (node.config.kind === 'source' ? [node.config.fileId] : [])),
  );
  const totalBytes = [...fileIds].reduce(
    (sum, id) =>
      sum +
      (typeof sources[id]?.text === 'string'
        ? new TextEncoder().encode(sources[id].text).length
        : 0),
    0,
  );
  if (totalBytes > MAX_BYTES)
    throw new Error('Все источники вместе должны занимать не больше 50 МБ.');
  const start = performance.now();
  const tables = new Map<string, Table>();
  const results: StepResult[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const id of topologicalOrder(graph)) {
    const node = byId.get(id)!;
    const stepStart = performance.now();
    let result: StepResult;
    try {
      let table: Table;
      let warnings: string[] = [];
      if (node.config.kind === 'source') {
        const file = sources[node.config.fileId];
        if (!file) throw new Error('Выберите локальный CSV для этого источника.');
        const parsed = parseCSV(file.text, file.delimiter);
        table = parsed;
        warnings = parsed.warnings;
      } else {
        const incoming = graph.edges.find((e) => e.target === id)!;
        const input = tables.get(incoming.source);
        if (!input) {
          result = {
            nodeId: id,
            status: 'skipped',
            count: 0,
            columns: [],
            types: [],
            preview: [],
            ms: 0,
            error: 'Входной шаг завершился ошибкой.',
            warnings: [],
          };
          results.push(result);
          onStep?.(result);
          continue;
        }
        const output = transform(input, node.config);
        table = output.table;
        warnings = output.warnings;
      }
      tables.set(id, table);
      result = {
        nodeId: id,
        status: 'success',
        count: table.rows.length,
        columns: table.columns,
        types: table.types,
        preview: table.rows.slice(0, 50),
        ms: performance.now() - stepStart,
        warnings,
      };
    } catch (e) {
      result = {
        nodeId: id,
        status: 'error',
        columns: [],
        types: [],
        count: 0,
        preview: [],
        ms: performance.now() - stepStart,
        error: (e as Error).message,
        warnings: [],
      };
    }
    results.push(result);
    onStep?.(result);
  }
  return { results, tables, ms: performance.now() - start };
}
export const kindLabels: Record<Config['kind'], string> = {
  source: 'Источник CSV',
  filter: 'Фильтр строк',
  select: 'Выбор столбцов',
  aggregate: 'Группировка',
  export: 'Выгрузка CSV',
};
export function createConfig(kind: Config['kind']): Config {
  if (kind === 'source') return { kind, fileId: '' };
  if (kind === 'filter') return { kind, column: '', op: 'contains', value: '', type: 'text' };
  if (kind === 'select') return { kind, columns: [] };
  if (kind === 'aggregate')
    return {
      kind,
      groupBy: [],
      metrics: [{ op: 'count', column: '', alias: 'Количество' }],
      invalid: 'reject',
    };
  return { kind, filename: 'результат.csv', delimiter: ';' };
}
