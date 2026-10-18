import { describe, expect, it } from 'vitest';
import {
  canConnect,
  createConfig,
  parseGraph,
  restoreSources,
  runGraph,
  transform,
  validateGraph,
} from './pipeline';
import type { Config, Graph, Table } from './pipeline';
import { exampleGraph, exampleSources } from './example';
import { exportCSV, parseCSV } from './table';
const sample: Table = {
  columns: ['Отдел', 'Сумма', 'Статус'],
  types: ['text', 'number', 'text'],
  rows: [
    ['А', '10', 'Готов'],
    ['А', '20', 'Готов'],
    ['Б', '5', 'В работе'],
    ['Б', '', 'Готов'],
  ],
};
describe('graph validation and import', () => {
  it('accepts a usable graph and rejects cycles, including disconnected cycles', () => {
    expect(validateGraph(exampleGraph)).toEqual([]);
    const graph = structuredClone(exampleGraph);
    graph.edges.push({ id: 'back', source: 'aggregate', target: 'filter' });
    expect(validateGraph(graph).some((i) => i.message.includes('цикл'))).toBe(true);
  });
  it('checks missing inputs, duplicated nodes and incompatible ports', () => {
    const graph = structuredClone(exampleGraph);
    graph.nodes.push(structuredClone(graph.nodes[0]));
    graph.edges = [{ id: 'bad', source: 'export', target: 'source' }];
    const messages = validateGraph(graph)
      .map((i) => i.message)
      .join(' ');
    expect(messages).toContain('повторяются');
    expect(messages).toContain('Несовместимые');
    expect(messages).toContain('Подключите');
  });
  it('allows branching but rejects a second input, self-connection and cycle', () => {
    const graph = structuredClone(exampleGraph);
    graph.nodes.push({
      id: 'other',
      label: 'Другой фильтр',
      position: { x: 0, y: 0 },
      config: createConfig('filter'),
    });
    expect(canConnect(graph, 'source', 'other')).toBe(true);
    expect(canConnect(graph, 'source', 'filter')).toBe(false);
    expect(canConnect(graph, 'other', 'other')).toBe(false);
    const disconnected = { ...graph, edges: graph.edges.filter((e) => e.target !== 'filter') };
    expect(canConnect(disconnected, 'aggregate', 'filter')).toBe(false);
  });
  it('validates imported configuration, version, coordinates and size rather than casting JSON', () => {
    expect(parseGraph(JSON.stringify(exampleGraph))).toEqual(exampleGraph);
    expect(() => parseGraph('{"version":999}')).toThrow('Неверный формат');
    const bad = structuredClone(exampleGraph);
    (bad.nodes[0].config as any).kind = 'javascript';
    expect(() => parseGraph(JSON.stringify(bad))).toThrow();
    expect(() => parseGraph('x'.repeat(1_000_001))).toThrow('1 МБ');
  });
  it('keeps readable source text when persisted display metadata is corrupt', () => {
    expect(restoreSources(null)).toEqual({});
    expect(
      restoreSources({
        broken: null,
        metadata: { text: 'a;b\nx;2', columns: [null], count: 'oops', delimiter: {} },
      }),
    ).toEqual({
      metadata: {
        id: 'metadata',
        name: 'Восстановленный.csv',
        text: 'a;b\nx;2',
        columns: [],
        count: 0,
        delimiter: '',
      },
    });
  });
});
describe('real table operations', () => {
  it('filters typed numbers and checks invalid comparison boundaries', () => {
    const config = {
      kind: 'filter',
      column: 'Сумма',
      op: 'gt',
      value: '8',
      type: 'number',
    } as const;
    expect(transform(sample, config).table.rows).toEqual(sample.rows.slice(0, 2));
    expect(() => transform(sample, { ...config, value: 'oops' })).toThrow('не соответствует');
  });
  it('projects columns in requested order and fails for missing fields', () => {
    const result = transform(sample, { kind: 'select', columns: ['Сумма', 'Отдел'] }).table;
    expect(result.columns).toEqual(['Сумма', 'Отдел']);
    expect(result.rows[0]).toEqual(['10', 'А']);
    expect(() => transform(sample, { kind: 'select', columns: ['missing'] })).toThrow(
      'отсутствует',
    );
    expect(() => transform(sample, { kind: 'select', columns: ['Отдел', 'Отдел'] })).toThrow(
      'повторяются',
    );
  });
  it('aggregates multiple metrics, blanks and multiple group keys without key collisions', () => {
    const config: Config = {
      kind: 'aggregate',
      groupBy: ['Отдел'],
      metrics: [
        { op: 'sum', column: 'Сумма', alias: 'Итого' },
        { op: 'count', column: '', alias: 'Строк' },
        { op: 'avg', column: 'Сумма', alias: 'Среднее' },
      ],
      invalid: 'reject',
    };
    const output = transform(sample, config);
    expect(output.table.rows).toEqual([
      ['А', '30', '2', '15'],
      ['Б', '5', '2', '5'],
    ]);
    const unusual: Table = {
      columns: ['a', 'b'],
      types: ['text', 'text'],
      rows: [
        ['a|b', 'c'],
        ['a', 'b|c'],
      ],
    };
    expect(
      transform(unusual, {
        kind: 'aggregate',
        groupBy: ['a', 'b'],
        metrics: [{ op: 'count', column: '', alias: 'n' }],
        invalid: 'reject',
      }).table.rows.length,
    ).toBe(2);
  });
  it('does not silently discard invalid numeric values and validates metric aliases', () => {
    const invalid = { ...sample, rows: [['А', 'oops', 'Готов']] };
    const config: Extract<Config, { kind: 'aggregate' }> = {
      kind: 'aggregate',
      groupBy: [],
      metrics: [{ op: 'sum', column: 'Сумма', alias: 'total' }],
      invalid: 'reject',
    };
    expect(() => transform(invalid, config)).toThrow('не является числом');
    const output = transform(invalid, { ...config, invalid: 'skip' });
    expect(output.table.rows).toEqual([['']]);
    expect(output.warnings[0]).toContain('1');
    expect(() =>
      transform(sample, {
        ...config,
        groupBy: ['Отдел'],
        metrics: [{ op: 'count', column: '', alias: 'Отдел' }],
      }),
    ).toThrow('уникальными');
  });
  it('distinguishes empty global and grouped aggregates, and count(column) from count(*)', () => {
    const config: Extract<Config, { kind: 'aggregate' }> = {
      kind: 'aggregate',
      groupBy: [],
      metrics: [
        { op: 'count', column: '', alias: 'n' },
        { op: 'sum', column: 'Сумма', alias: 's' },
      ],
      invalid: 'reject',
    };
    expect(transform({ ...sample, rows: [] }, config).table.rows).toEqual([['0', '']]);
    expect(
      transform({ ...sample, rows: [] }, { ...config, groupBy: ['Отдел'] }).table.rows,
    ).toEqual([]);
    expect(
      transform(sample, { ...config, metrics: [{ op: 'count', column: 'Сумма', alias: 'n' }] })
        .table.rows,
    ).toEqual([['3']]);
  });
});
describe('pipeline execution', () => {
  it('executes the real example and produces an exact exportable result', () => {
    const output = runGraph(exampleGraph, exampleSources);
    expect(output.results.every((r) => r.status === 'success')).toBe(true);
    expect(output.tables.get('filter')!.rows.length).toBe(76);
    const aggregate = output.tables.get('aggregate')!;
    expect(aggregate.columns).toEqual(['Отдел', 'Выручка', 'Счетов']);
    expect(aggregate.rows.reduce((sum, r) => sum + Number(r[2]), 0)).toBe(76);
    const expected = exampleSources.demo.text
      .split('\n')
      .slice(1)
      .filter((r) => r.split(';')[2] === 'Оплачен')
      .reduce((sum, r) => sum + Number(r.split(';')[3]), 0);
    expect(aggregate.rows.reduce((sum, r) => sum + Number(r[1]), 0)).toBe(expected);
    const csv = exportCSV(aggregate.columns, aggregate.rows, ';');
    expect(parseCSV(csv, ';').rows).toEqual(aggregate.rows);
  });
  it('marks dependent nodes skipped while an independent branch can finish', () => {
    const graph: Graph = structuredClone(exampleGraph);
    graph.nodes[1].config = {
      kind: 'filter',
      column: 'Отсутствует',
      op: 'contains',
      value: 'x',
      type: 'text',
    };
    graph.nodes.push({
      id: 'independent',
      label: 'Вторая выгрузка',
      config: createConfig('export'),
      position: { x: 0, y: 300 },
    });
    graph.edges.push({ id: 'branch', source: 'source', target: 'independent' });
    const output = runGraph(graph, exampleSources);
    expect(output.results.find((r) => r.nodeId === 'filter')!.status).toBe('error');
    expect(output.results.find((r) => r.nodeId === 'aggregate')!.status).toBe('skipped');
    expect(output.results.find((r) => r.nodeId === 'export')!.status).toBe('skipped');
    expect(output.tables.get('independent')!.rows.length).toBe(96);
  });
  it('reports missing source files and never fabricates outputs', () => {
    const output = runGraph(exampleGraph, {});
    expect(output.results[0].status).toBe('error');
    expect(output.tables.size).toBe(0);
    expect(output.results.slice(1).every((r) => r.status === 'skipped')).toBe(true);
  });
});
