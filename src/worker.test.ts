import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exampleGraph, exampleSources } from './example';
const messages: any[] = [];
const scope = {
  onmessage: null as
    ((event: { data: { id: number; kind: string; payload: unknown } }) => void) | null,
  postMessage: (data: unknown) => messages.push(data),
};
let seq = 0;
beforeAll(async () => {
  vi.stubGlobal('self', scope);
  await import('./pipeline.worker');
});
function dispatch(kind: string, payload: unknown) {
  const id = ++seq;
  scope.onmessage!({ data: { id, kind, payload } });
  return messages.find((m) => m.id === id);
}
describe('worker execution protocol', () => {
  it('inspects real CSV preserving multiline quotes and reports source dimensions', () => {
    expect(
      dispatch('inspect', { text: 'name;note\nАня;"первая;\nвторая"', delimiter: ';' }).result,
    ).toMatchObject({ columns: ['name', 'note'], count: 1 });
  });
  it('runs a graph, streams per-node results, pages and exports the executed table', () => {
    const run = dispatch('run', { graph: exampleGraph, sources: exampleSources });
    expect(run.result.results).toHaveLength(4);
    expect(messages.filter((m) => m.progress)).toHaveLength(4);
    const page = dispatch('page', { nodeId: 'aggregate', offset: 1 });
    expect(page.result.rows.length).toBe(2);
    const output = dispatch('export', { nodeId: 'export', delimiter: ';' });
    expect(output.result).toContain('"Отдел";"Выручка";"Счетов"');
  });
  it('clears stale execution before a failed run', () => {
    const graph = structuredClone(exampleGraph);
    graph.edges = [];
    expect(dispatch('run', { graph, sources: exampleSources }).error).toContain('Подключите');
    expect(dispatch('export', { nodeId: 'export', delimiter: ';' }).error).toContain(
      'Нет успешного',
    );
  });
});
