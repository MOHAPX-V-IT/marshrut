import type { StepResult } from './pipeline';
export class PipelineClient {
  private worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  onProgress?: (result: StepResult) => void;
  constructor() {
    this.worker.onmessage = ({ data }) => {
      if (data.progress) {
        this.onProgress?.(data.progress);
        return;
      }
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    this.worker.onerror = () => {
      for (const p of this.pending.values())
        p.reject(new Error('Фоновый поток недоступен. Повторите запуск.'));
      this.pending.clear();
    };
  }
  call<T>(kind: string, payload: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, kind, payload });
    });
  }
  close() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Операция отменена.'));
    this.pending.clear();
  }
}
