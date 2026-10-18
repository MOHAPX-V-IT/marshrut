import { parseCSV, exportCSV } from './table';
import { graphSchema, runGraph } from './pipeline';
import type { Execution, Sources } from './pipeline';
let execution: Execution | null = null;
self.onmessage = ({ data }: MessageEvent) => {
  const { id, kind, payload } = data;
  try {
    if (kind === 'inspect') {
      const parsed = parseCSV(payload.text, payload.delimiter);
      self.postMessage({
        id,
        result: {
          columns: parsed.columns,
          count: parsed.rows.length,
          delimiter: parsed.delimiter,
          warnings: parsed.warnings,
        },
      });
    } else if (kind === 'run') {
      execution = null;
      execution = runGraph(graphSchema.parse(payload.graph), payload.sources as Sources, (result) =>
        self.postMessage({ progress: result }),
      );
      self.postMessage({ id, result: { results: execution.results, ms: execution.ms } });
    } else if (kind === 'export') {
      const table = execution?.tables.get(payload.nodeId);
      if (!table) throw new Error('Нет успешного результата. Запустите маршрут.');
      self.postMessage({ id, result: exportCSV(table.columns, table.rows, payload.delimiter) });
    } else if (kind === 'page') {
      const table = execution?.tables.get(payload.nodeId);
      if (!table) throw new Error('Результат недоступен.');
      self.postMessage({
        id,
        result: {
          offset: payload.offset,
          rows: table.rows.slice(payload.offset, payload.offset + 50),
        },
      });
    } else throw new Error('Неизвестная операция.');
  } catch (e) {
    self.postMessage({ id, error: (e as Error).message });
  }
};
