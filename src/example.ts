import type { Graph, Sources } from './pipeline';
const csv = [
  'Номер;Отдел;Статус;Сумма;Город',
  ...Array.from(
    { length: 96 },
    (_, i) =>
      `INV-${String(i + 1).padStart(3, '0')};${['Продажи', 'Сервис', 'Документы'][i % 3]};${i % 5 === 0 ? 'Ожидает' : 'Оплачен'};${1500 + i * 230};${['Москва', 'Казань', 'Самара'][i % 3]}`,
  ),
].join('\n');
export const exampleSources: Sources = {
  demo: {
    id: 'demo',
    name: 'Счета — пример.csv',
    text: csv,
    delimiter: ';',
    columns: ['Номер', 'Отдел', 'Статус', 'Сумма', 'Город'],
    count: 96,
  },
};
export const exampleGraph: Graph = {
  version: 1,
  title: 'Оплаченные счета по отделам',
  nodes: [
    {
      id: 'source',
      label: 'Счета за месяц',
      position: { x: 30, y: 150 },
      config: { kind: 'source', fileId: 'demo' },
    },
    {
      id: 'filter',
      label: 'Только оплаченные',
      position: { x: 300, y: 70 },
      config: { kind: 'filter', column: 'Статус', op: 'equals', value: 'Оплачен', type: 'text' },
    },
    {
      id: 'aggregate',
      label: 'Итоги по отделам',
      position: { x: 570, y: 150 },
      config: {
        kind: 'aggregate',
        groupBy: ['Отдел'],
        metrics: [
          { op: 'sum', column: 'Сумма', alias: 'Выручка' },
          { op: 'count', column: '', alias: 'Счетов' },
        ],
        invalid: 'reject',
      },
    },
    {
      id: 'export',
      label: 'Отчёт для команды',
      position: { x: 840, y: 70 },
      config: { kind: 'export', filename: 'оплаченные-по-отделам.csv', delimiter: ';' },
    },
  ],
  edges: [
    { id: 's-f', source: 'source', target: 'filter' },
    { id: 'f-a', source: 'filter', target: 'aggregate' },
    { id: 'a-e', source: 'aggregate', target: 'export' },
  ],
};
export const emptyGraph: Graph = { version: 1, title: 'Новый маршрут', nodes: [], edges: [] };
