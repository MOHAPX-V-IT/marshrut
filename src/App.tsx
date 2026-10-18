import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  MarkerType,
} from '@xyflow/react';
import type { Node, NodeProps, NodeChange, Connection, ReactFlowInstance } from '@xyflow/react';
import { get, set, del } from 'idb-keyval';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  Columns3,
  FileInput,
  FileOutput,
  Filter,
  GitBranch,
  Grip,
  Layers3,
  Link2,
  Maximize2,
  MoreHorizontal,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sigma,
  Square,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import {
  canConnect,
  createConfig,
  kindLabels,
  parseGraph,
  restoreSources,
  validateGraph,
} from './pipeline';
import type { Config, Graph, SourceFile, Sources, Step, StepResult } from './pipeline';
import { MAX_BYTES } from './table';
import { PipelineClient } from './worker-client';
import { emptyGraph, exampleGraph, exampleSources } from './example';

const icons = {
  source: FileInput,
  filter: Filter,
  select: Columns3,
  aggregate: Sigma,
  export: FileOutput,
};
const captions = {
  source: 'Локальный табличный файл',
  filter: 'Оставить подходящие строки',
  select: 'Сохранить нужные столбцы',
  aggregate: 'Посчитать итоги по группам',
  export: 'Скачать готовый CSV',
};
const format = (n: number) => new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(n);
type FlowNode = Node<{ step: Step; index: number; result?: StepResult; fileName?: string }, 'step'>;
function StepCard({ data, selected }: NodeProps<FlowNode>) {
  const { step, index, result } = data;
  const Icon = icons[step.config.kind];
  const c = step.config;
  const detail =
    c.kind === 'source'
      ? data.fileName || 'Выберите CSV'
      : c.kind === 'filter'
        ? `${c.column || 'Столбец'} ${c.op === 'equals' ? '=' : c.op === 'gt' ? '>' : c.op === 'lt' ? '<' : c.op === 'contains' ? '∋' : c.op === 'empty' ? 'пусто' : 'не пусто'} ${c.value}`
        : c.kind === 'select'
          ? `${c.columns.length} столбцов`
          : c.kind === 'aggregate'
            ? `${c.groupBy.join(', ') || 'Вся таблица'} · ${c.metrics.length} метрики`
            : c.filename;
  return (
    <div
      className={`step-card kind-${c.kind} ${selected ? 'is-selected' : ''} ${result?.status === 'error' ? 'has-error' : ''}`}
    >
      {c.kind !== 'source' && (
        <Handle type="target" position={Position.Left} id="in" aria-label="Входная таблица" />
      )}
      <div className="step-meta">
        <span className="step-icon">
          <Icon size={16} />
        </span>
        <span>{kindLabels[c.kind]}</span>
        <span className="step-number">{String(index + 1).padStart(2, '0')}</span>
      </div>
      <h3>{step.label}</h3>
      <div className="step-detail" title={detail}>
        {detail}
      </div>
      <div className={`step-status ${result?.status || ''}`}>
        {result ? (
          <>
            {result.status === 'success' ? <Check size={11} /> : <span className="status-square" />}
            <span>
              {result.status === 'success'
                ? `${format(result.count)} строк`
                : result.status === 'error'
                  ? 'Ошибка шага'
                  : 'Пропущен'}
            </span>
            <small>{format(result.ms)} мс</small>
          </>
        ) : (
          <>
            <span className="status-square" />
            <span>Готов к настройке</span>
            <MoreHorizontal size={12} />
          </>
        )}
      </div>
      {c.kind !== 'export' && (
        <Handle type="source" position={Position.Right} id="out" aria-label="Выходная таблица" />
      )}
    </div>
  );
}
const nodeTypes = { step: StepCard };
const storageKey = 'marshrut.workspace.v1';
function saveDownload(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export default function App() {
  const [graph, setGraph] = useState<Graph>(structuredClone(exampleGraph));
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [sources, setSources] = useState<Sources>(structuredClone(exampleSources));
  const [selected, setSelected] = useState('source');
  const past = useRef<Graph[]>([]);
  const future = useRef<Graph[]>([]);
  const [, historyVersion] = useState(0);
  const dragStart = useRef<Graph | null>(null);
  const client = useRef<PipelineClient | null>(null);
  const flow = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const token = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const schemaInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [results, setResults] = useState<StepResult[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState('');
  const [ready, setReady] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const [tab, setTab] = useState<'preview' | 'log'>('preview');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<string[][] | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showPalette, setShowPalette] = useState(true);
  const [separator, setSeparator] = useState('');
  const [encoding, setEncoding] = useState('utf-8');
  const makeClient = useCallback(() => {
    const c = new PipelineClient();
    c.onProgress = (result) =>
      setResults((list) => [...list.filter((r) => r.nodeId !== result.nodeId), result]);
    return c;
  }, []);
  useEffect(() => {
    client.current = makeClient();
    let active = true;
    void get<{ graph: Graph; sources: unknown }>(storageKey)
      .then((value) => {
        if (!active) return;
        if (value) {
          const restored = parseGraph(JSON.stringify(value.graph));
          setGraph(restored);
          setSources(restoreSources(value.sources));
          setSelected(restored.nodes[0]?.id || '');
          setNotice(
            'Восстановлен последний маршрут. Для обновления результатов нажмите «Запустить».',
          );
        }
        setReady(true);
      })
      .catch(() => {
        if (active) {
          setSaved('Сохранённая копия недоступна или повреждена');
          setReady(true);
        }
      });
    return () => {
      active = false;
      ++token.current;
      client.current?.close();
      client.current = null;
    };
  }, [makeClient]);
  useEffect(() => {
    if (!ready) return;
    const timeout = window.setTimeout(() => {
      setSaved('Сохраняем…');
      const needed = Object.fromEntries(
        Object.entries(sources).filter(([id]) =>
          graph.nodes.some((n) => n.config.kind === 'source' && n.config.fileId === id),
        ),
      );
      void set(storageKey, { graph, sources: needed })
        .then(() => setSaved('Сохранено на устройстве'))
        .catch(() => setSaved('Не сохранено: квота или доступ к хранилищу'));
    }, 550);
    return () => clearTimeout(timeout);
  }, [graph, sources, ready]);
  function clearResults() {
    setResults([]);
    setMs(null);
    setOffset(0);
    setPage(null);
  }
  function commit(next: Graph) {
    if (busy) return;
    past.current = [...past.current.slice(-59), structuredClone(graphRef.current)];
    future.current = [];
    setGraph(next);
    historyVersion((v) => v + 1);
    clearResults();
  }
  function updateStep(patch: Partial<Step>) {
    commit({
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === selected ? { ...n, ...patch } : n)),
    });
  }
  function undo() {
    if (busy || !past.current.length) return;
    future.current = [structuredClone(graph), ...future.current];
    setGraph(past.current.pop()!);
    historyVersion((v) => v + 1);
    clearResults();
  }
  function redo() {
    if (busy || !future.current.length) return;
    past.current.push(structuredClone(graph));
    setGraph(future.current.shift()!);
    historyVersion((v) => v + 1);
    clearResults();
  }
  function addStep(kind: Config['kind']) {
    if (graph.nodes.length >= 40) {
      setError('В одном маршруте до 40 шагов.');
      return;
    }
    const id = crypto.randomUUID();
    const last = graph.nodes.at(-1);
    const node: Step = {
      id,
      label: kindLabels[kind],
      config: createConfig(kind),
      position: {
        x: last ? last.position.x + 265 : 60,
        y: last ? (last.position.y === 70 ? 210 : 70) : 130,
      },
    };
    const next = { ...graph, nodes: [...graph.nodes, node] };
    if (last && canConnect(next, last.id, id))
      next.edges = [...graph.edges, { id: crypto.randomUUID(), source: last.id, target: id }];
    commit(next);
    setSelected(id);
    window.setTimeout(() => flow.current?.fitView({ padding: 0.22, duration: 350 }), 80);
  }
  function connect(connection: Connection) {
    if (busy) return;
    if (!canConnect(graph, connection.source, connection.target)) {
      setError('Связь отклонена: проверьте направление, единственный вход и отсутствие циклов.');
      return;
    }
    commit({
      ...graph,
      edges: [
        ...graph.edges,
        { id: crypto.randomUUID(), source: connection.source, target: connection.target },
      ],
    });
  }
  function changeNodes(changes: NodeChange<FlowNode>[]) {
    if (busy) return;
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length) {
      commit({
        ...graph,
        nodes: graph.nodes.filter((n) => !removed.includes(n.id)),
        edges: graph.edges.filter(
          (e) => !removed.includes(e.source) && !removed.includes(e.target),
        ),
      });
      return;
    }
    const positions = changes.filter((c) => c.type === 'position');
    if (positions.length)
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => {
          const p = positions.find((p) => p.id === n.id);
          return p?.position ? { ...n, position: p.position } : n;
        }),
      }));
  }
  function removeStep() {
    if (!selected) return;
    commit({
      ...graph,
      nodes: graph.nodes.filter((n) => n.id !== selected),
      edges: graph.edges.filter((e) => e.source !== selected && e.target !== selected),
    });
    setSelected('');
  }
  async function run() {
    if (!client.current || busy || !ready) return;
    const issues = validateGraph(graph);
    if (issues.length) {
      setError(
        issues
          .map(
            (i) =>
              `${i.nodeId ? graph.nodes.find((n) => n.id === i.nodeId)?.label + ': ' : ''}${i.message}`,
          )
          .join(' '),
      );
      return;
    }
    const request = ++token.current;
    setBusy('Выполняем маршрут');
    setError('');
    setNotice('');
    clearResults();
    try {
      const result = await client.current.call<{ results: StepResult[]; ms: number }>('run', {
        graph,
        sources,
      });
      if (request !== token.current) return;
      setResults(result.results);
      setMs(result.ms);
      setBusy('');
      const failures = result.results.filter((r) => r.status === 'error').length;
      setNotice(
        failures
          ? `Выполнение завершено. Ошибок: ${failures}. Выберите шаг для подробностей.`
          : `Маршрут выполнен за ${format(result.ms)} мс. Результат готов к выгрузке.`,
      );
      const exportNode = graph.nodes.find((n) => n.config.kind === 'export');
      if (exportNode) setSelected(exportNode.id);
      setTab('preview');
    } catch (e) {
      if (request === token.current) {
        setError((e as Error).message);
        setBusy('');
      }
    }
  }
  function cancel() {
    ++token.current;
    client.current?.close();
    client.current = makeClient();
    setBusy('');
    clearResults();
    setNotice('Выполнение отменено. Маршрут и исходные файлы сохранены.');
  }
  async function uploadSource(file?: File) {
    if (!file || !client.current) return;
    const step = graph.nodes.find((n) => n.id === selected);
    if (step?.config.kind !== 'source') return;
    if (file.size > MAX_BYTES) {
      setError('Один файл должен быть не больше 50 МБ.');
      return;
    }
    const request = ++token.current;
    setBusy('Читаем источник');
    setError('');
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(await file.arrayBuffer());
      const total = Object.entries(sources)
        .filter(
          ([id]) =>
            id !== step.id &&
            graph.nodes.some((n) => n.config.kind === 'source' && n.config.fileId === id),
        )
        .reduce(
          (sum, [, file]) => sum + new TextEncoder().encode(file.text).length,
          new TextEncoder().encode(text).length,
        );
      if (total > MAX_BYTES)
        throw new Error('Все источники вместе должны занимать не больше 50 МБ.');
      const info = await client.current.call<{
        columns: string[];
        count: number;
        delimiter: string;
        warnings: string[];
      }>('inspect', { text, delimiter: separator });
      if (request !== token.current) return;
      const source: SourceFile = {
        id: step.id,
        name: file.name,
        text,
        delimiter: info.delimiter,
        columns: info.columns,
        count: info.count,
      };
      setSources((s) => ({ ...s, [step.id]: source }));
      past.current = [...past.current.slice(-59), structuredClone(graph)];
      future.current = [];
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === step.id ? { ...n, config: { kind: 'source', fileId: step.id } } : n,
        ),
      }));
      historyVersion((v) => v + 1);
      clearResults();
      setNotice(
        `Источник подключён: ${file.name}, ${format(info.count)} строк.${info.warnings.length ? ' ' + info.warnings.join(' ') : ''}`,
      );
      setBusy('');
    } catch (e) {
      if (request === token.current) {
        setError(
          (e as Error).message.includes('encoded')
            ? 'Не удалось декодировать файл. Смените кодировку.'
            : (e as Error).message,
        );
        setBusy('');
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  }
  async function importSchema(file?: File) {
    if (!file) return;
    if (file.size > 1_000_000) {
      setError('Схема больше 1 МБ.');
      return;
    }
    try {
      const next = parseGraph(await file.text());
      next.nodes = next.nodes.map((node) =>
        node.config.kind === 'source' ? { ...node, config: { kind: 'source', fileId: '' } } : node,
      );
      commit(next);
      setSelected(next.nodes[0]?.id || '');
      setNotice('Схема загружена. JSON не содержит CSV: подключите свои файлы к источникам.');
      window.setTimeout(() => flow.current?.fitView({ padding: 0.2, duration: 300 }), 100);
    } catch (e) {
      setError((e as Error).message);
    }
    if (schemaInput.current) schemaInput.current.value = '';
  }
  async function downloadResult(nodeId: string) {
    if (!client.current || busy) return;
    const node = graph.nodes.find((n) => n.id === nodeId);
    const config = node?.config;
    const delimiter = config?.kind === 'export' ? config.delimiter : ';';
    const filename =
      config?.kind === 'export' ? config.filename : `${node?.label || 'результат'}.csv`;
    const request = token.current;
    setBusy('Подготавливаем выгрузку');
    try {
      const csv = await client.current.call<string>('export', { nodeId, delimiter });
      if (request !== token.current) return;
      saveDownload(
        csv,
        filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`,
        'text/csv;charset=utf-8;',
      );
      setBusy('');
      setNotice('CSV скачан. Начальные символы формул защищены апострофом.');
    } catch (e) {
      if (request === token.current) {
        setError((e as Error).message);
        setBusy('');
      }
    }
  }
  const selectedStep = graph.nodes.find((n) => n.id === selected);
  const selectedResult = results.find((r) => r.nodeId === selected);
  const incoming = graph.edges.find((e) => e.target === selected);
  const upstream = results.find((r) => r.nodeId === incoming?.source);
  function availableColumns(stepId: string, seen = new Set<string>()): string[] {
    if (seen.has(stepId)) return [];
    seen.add(stepId);
    const node = graph.nodes.find((n) => n.id === stepId);
    if (!node) return [];
    const c = node.config;
    if (c.kind === 'source') return sources[c.fileId]?.columns || [];
    if (c.kind === 'select') return c.columns;
    if (c.kind === 'aggregate') return [...c.groupBy, ...c.metrics.map((m) => m.alias)];
    const edge = graph.edges.find((e) => e.target === stepId);
    return edge ? availableColumns(edge.source, seen) : [];
  }
  const inputColumns = upstream?.columns || (incoming ? availableColumns(incoming.source) : []);
  const nodes: FlowNode[] = useMemo(
    () =>
      graph.nodes.map((step, index) => ({
        id: step.id,
        type: 'step',
        position: step.position,
        selected: selected === step.id,
        data: {
          step,
          index,
          result: results.find((r) => r.nodeId === step.id),
          fileName: step.config.kind === 'source' ? sources[step.config.fileId]?.name : undefined,
        },
      })),
    [graph.nodes, selected, results, sources],
  );
  const edges = useMemo(
    () =>
      graph.edges.map((e) => ({
        ...e,
        sourceHandle: 'out',
        targetHandle: 'in',
        type: 'smoothstep',
        style: {
          stroke:
            results.find((r) => r.nodeId === e.source)?.status === 'success'
              ? '#356957'
              : '#465f66',
          strokeWidth: 1.8,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#465f66', width: 16, height: 16 },
      })),
    [graph.edges, results],
  );
  const issues = useMemo(() => validateGraph(graph), [graph]);
  useEffect(() => {
    setOffset(0);
    setPage(null);
  }, [selected, results]);
  useEffect(() => {
    if (offset === 0 || !selectedResult || selectedResult.status !== 'success' || !client.current) {
      setPage(null);
      return;
    }
    let active = true;
    void client.current
      .call<{ rows: string[][] }>('page', { nodeId: selected, offset })
      .then((r) => {
        if (active) setPage(r.rows);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [offset, selected]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      const editing = (e.target as HTMLElement)?.closest(
        'input,textarea,select,[contenteditable=true]',
      );
      if (editing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void run();
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  function openHelp() {
    returnFocus.current = document.activeElement as HTMLElement;
    setShowHelp(true);
  }
  function closeHelp() {
    setShowHelp(false);
    returnFocus.current?.focus();
  }
  function resetDemo() {
    commit(structuredClone(exampleGraph));
    setSources((s) => ({ ...s, ...structuredClone(exampleSources) }));
    setSelected('source');
    setError('');
    setNotice('Загружен рабочий пример. Нажмите «Запустить», чтобы обработать 96 счетов.');
    window.setTimeout(() => flow.current?.fitView({ padding: 0.2, duration: 300 }), 100);
  }
  return (
    <div className="app">
      <a className="skip-link" href="#settings">
        К настройке шага
      </a>
      <header className="app-header">
        <a href="#" className="brand">
          <span className="route-mark">
            <i />
            <i />
            <i />
          </span>
          маршрут<span className="brand-version">RC.1</span>
        </a>
        <span className="header-divider" />
        <div className="workspace-label">
          <span className="local-dot" /> Локальное пространство <ChevronDown size={12} />
        </div>
        <div className="header-right">
          <span>
            <ShieldCheck size={14} /> Данные остаются в браузере
          </span>
          <button aria-label="Справка" onClick={openHelp}>
            <CircleHelp size={19} />
          </button>
        </div>
      </header>
      <div className="project-bar">
        <div className="project-caption">
          <p>КОНВЕЙЕР ТАБЛИЧНЫХ ДАННЫХ</p>
          <label>
            <GitBranch size={22} />
            <input
              aria-label="Название маршрута"
              value={graph.title}
              disabled={!!busy}
              onChange={(e) => {
                if (e.target.value.trim())
                  commit({ ...graph, title: e.target.value.slice(0, 120) });
              }}
            />
          </label>
          <span>{saved || 'Один источник. Несколько действий. Готовый результат.'}</span>
        </div>
        <div className="project-actions">
          <div className="history-buttons">
            <button
              title="Отменить (Ctrl+Z)"
              aria-label="Отменить изменение"
              onClick={undo}
              disabled={!!busy || !past.current.length}
            >
              <Undo2 size={17} />
            </button>
            <button
              title="Повторить (Ctrl+Shift+Z)"
              aria-label="Повторить изменение"
              onClick={redo}
              disabled={!!busy || !future.current.length}
            >
              <Redo2 size={17} />
            </button>
          </div>
          <button
            className="button"
            disabled={!!busy}
            onClick={() =>
              saveDownload(
                JSON.stringify(
                  {
                    ...graph,
                    nodes: graph.nodes.map((node) =>
                      node.config.kind === 'source'
                        ? { ...node, config: { kind: 'source', fileId: '' } }
                        : node,
                    ),
                  },
                  null,
                  2,
                ),
                'маршрут.json',
                'application/json',
              )
            }
          >
            <ArrowDownToLine size={15} /> Схема
          </button>
          <button
            className="button run-button"
            onClick={() => void run()}
            disabled={!!busy || !ready}
          >
            <Play size={14} fill="currentColor" /> Запустить <span>⌘ ↵</span>
          </button>
        </div>
      </div>
      <nav className="tool-strip" aria-label="Действия с маршрутом">
        <button onClick={() => setShowPalette((v) => !v)}>
          <Layers3 size={15} /> Шаги <span className="count-badge">{graph.nodes.length}</span>
        </button>
        <span className="strip-divider" />
        <button disabled={!!busy} onClick={() => schemaInput.current?.click()}>
          <Upload size={14} /> Импорт схемы
        </button>
        <button disabled={!!busy} onClick={resetDemo}>
          <RotateCcw size={14} /> Пример
        </button>
        <button
          disabled={!!busy}
          onClick={() => {
            commit(structuredClone(emptyGraph));
            setSelected('');
            setNotice('Добавьте источник и шаги из библиотеки.');
          }}
        >
          <Plus size={14} /> Новый
        </button>
        <span className="tool-status">
          {issues.length ? (
            <>
              <span className="amber-dot" />
              {issues.length} вопросов к связям
            </>
          ) : (
            <>
              <CheckCheck size={14} /> Связи проверены
            </>
          )}
        </span>
        <button
          className="fit-button"
          onClick={() => flow.current?.fitView({ padding: 0.2, duration: 300 })}
        >
          <Maximize2 size={14} /> Весь маршрут
        </button>
      </nav>
      <input
        ref={fileInput}
        type="file"
        className="sr-only"
        accept=".csv,.tsv,.txt,text/csv"
        onChange={(e) => void uploadSource(e.target.files?.[0])}
      />
      <input
        ref={schemaInput}
        type="file"
        className="sr-only"
        accept=".json,application/json"
        onChange={(e) => void importSchema(e.target.files?.[0])}
      />
      {(error || notice || busy) && (
        <div
          className={`notification ${error ? 'error' : busy ? 'working' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {busy ? (
            <span className="spinner" />
          ) : error ? (
            <span className="error-dot" />
          ) : (
            <Check size={14} />
          )}
          <span>{error || busy || notice}</span>
          {busy ? (
            <button onClick={cancel}>
              <Square size={11} /> Отменить
            </button>
          ) : (
            <button
              aria-label="Закрыть уведомление"
              onClick={() => {
                setError('');
                setNotice('');
              }}
            >
              <X size={15} />
            </button>
          )}
        </div>
      )}
      <div className={`studio ${showPalette ? '' : 'no-palette'}`}>
        <aside className="palette" hidden={!showPalette}>
          <div className="panel-heading">
            <span>БИБЛИОТЕКА ШАГОВ</span>
            <Grip size={14} />
          </div>
          <p className="panel-intro">
            Соберите маршрут
            <br />
            из понятных действий.
          </p>
          <div className="palette-list">
            {(Object.keys(kindLabels) as Config['kind'][]).map((kind, i) => {
              const Icon = icons[kind];
              return (
                <button
                  key={kind}
                  className={`palette-item kind-${kind}`}
                  onClick={() => addStep(kind)}
                  disabled={!!busy}
                >
                  <span className="palette-icon">
                    <Icon size={17} />
                  </span>
                  <span>
                    <strong>{kindLabels[kind]}</strong>
                    <small>{captions[kind]}</small>
                  </span>
                  <Plus size={13} />
                </button>
              );
            })}
          </div>
          <div className="palette-tip">
            <Link2 size={17} />
            <h3>Один шаг — один вход.</h3>
            <p>
              Потяните линию от правой точки шага к левой точке следующего. Для каждого шага — один
              вход.
            </p>
            <span>Нажмите шаг, чтобы настроить →</span>
          </div>
          <div className="palette-footer">
            <span className="local-dot" /> Обработка на устройстве
          </div>
        </aside>
        <section className="canvas-zone" aria-label="Визуальный редактор маршрута">
          <div className="canvas-label">
            <span>ПОЛЕ ОБРАБОТКИ / 01</span>
            <span>ВХОД → ДЕЙСТВИЯ → ВЫХОД</span>
          </div>
          <ReactFlow<FlowNode>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={(instance) => {
              flow.current = instance;
            }}
            onNodesChange={changeNodes}
            onNodeClick={(_, node) => setSelected(node.id)}
            onPaneClick={() => {}}
            onConnect={connect}
            isValidConnection={(c) => !busy && canConnect(graph, c.source, c.target)}
            onEdgesDelete={(deleted) => {
              if (!busy)
                commit({
                  ...graph,
                  edges: graph.edges.filter((e) => !deleted.some((d) => d.id === e.id)),
                });
            }}
            onNodeDragStart={() => {
              dragStart.current = structuredClone(graphRef.current);
            }}
            onNodeDragStop={() => {
              if (dragStart.current) {
                past.current = [...past.current.slice(-59), dragStart.current];
                future.current = [];
                historyVersion((v) => v + 1);
                dragStart.current = null;
              }
            }}
            nodesDraggable={!busy}
            nodesConnectable={!busy}
            elementsSelectable={!busy}
            deleteKeyCode={busy ? null : ['Backspace', 'Delete']}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            minZoom={0.2}
            maxZoom={1.5}
            proOptions={{ hideAttribution: false }}
            ariaLabelConfig={{
              'controls.zoomIn.ariaLabel': 'Приблизить',
              'controls.zoomOut.ariaLabel': 'Отдалить',
              'controls.fitView.ariaLabel': 'Показать весь маршрут',
            }}
          >
            <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="#cbd6d0" />
            <Controls showInteractive={false} />
          </ReactFlow>
          {graph.nodes.length === 0 && (
            <div className="canvas-empty">
              <GitBranch size={35} />
              <h2>Начните с исходного файла.</h2>
              <p>Начните с источника CSV в библиотеке слева.</p>
              <button className="button run-button" onClick={() => addStep('source')}>
                <Plus size={15} /> Добавить источник
              </button>
            </div>
          )}
          <div className="canvas-bottom">
            <span>Панорама: перетаскивание фона · масштаб: колесо</span>
            <span>{graph.edges.length} связей</span>
          </div>
        </section>
        <aside className="inspector" id="settings">
          <div className="panel-heading">
            <span>ИНСПЕКТОР ШАГА</span>
            <Settings2 size={14} />
          </div>
          {selectedStep ? (
            <>
              <div className={`inspector-title kind-${selectedStep.config.kind}`}>
                <span className="inspector-icon">
                  {(() => {
                    const Icon = icons[selectedStep.config.kind];
                    return <Icon size={21} />;
                  })()}
                </span>
                <div>
                  <small>{kindLabels[selectedStep.config.kind]}</small>
                  <h2>{selectedStep.label}</h2>
                </div>
              </div>
              <fieldset className="config-form" disabled={!!busy}>
                <label className="field">
                  Название
                  <input
                    value={selectedStep.label}
                    onChange={(e) => {
                      if (e.target.value.trim())
                        updateStep({ label: e.target.value.slice(0, 160) });
                    }}
                  />
                </label>
                {selectedStep.config.kind === 'source' && (
                  <>
                    <div
                      className="source-drop"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!busy) void uploadSource(e.dataTransfer.files[0]);
                      }}
                    >
                      <FileInput size={27} />
                      <strong>
                        {sources[selectedStep.config.fileId]?.name || 'Подключите CSV'}
                      </strong>
                      <span>
                        {sources[selectedStep.config.fileId]
                          ? `${format(sources[selectedStep.config.fileId].count)} строк · ${sources[selectedStep.config.fileId].columns.length} столбцов`
                          : 'Выберите или перетащите файл'}
                      </span>
                      <button className="button" onClick={() => fileInput.current?.click()}>
                        <Upload size={13} />{' '}
                        {sources[selectedStep.config.fileId] ? 'Заменить файл' : 'Выбрать файл'}
                      </button>
                    </div>
                    <div className="field-row">
                      <label className="field">
                        Разделитель
                        <select value={separator} onChange={(e) => setSeparator(e.target.value)}>
                          <option value="">Авто</option>
                          <option value=";">;</option>
                          <option value=",">,</option>
                          <option value={'\t'}>TAB</option>
                          <option value="|">|</option>
                        </select>
                      </label>
                      <label className="field">
                        Кодировка
                        <select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
                          <option value="utf-8">UTF-8</option>
                          <option value="windows-1251">1251</option>
                        </select>
                      </label>
                    </div>
                    <p className="field-help">
                      До 50 МБ на все источники. Первая запись — заголовки. Файл хранится только в
                      браузере.
                    </p>
                  </>
                )}
                {selectedStep.config.kind === 'filter' &&
                  (() => {
                    const c = selectedStep.config;
                    return (
                      <>
                        <label className="field">
                          Столбец
                          <select
                            value={c.column}
                            onChange={(e) =>
                              updateStep({ config: { ...c, column: e.target.value } })
                            }
                          >
                            <option value="">Выберите столбец</option>
                            {inputColumns.map((col) => (
                              <option key={col}>{col}</option>
                            ))}
                          </select>
                        </label>
                        <div className="field-row">
                          <label className="field">
                            Условие
                            <select
                              value={c.op}
                              onChange={(e) =>
                                updateStep({ config: { ...c, op: e.target.value as typeof c.op } })
                              }
                            >
                              <option value="contains">содержит</option>
                              <option value="equals">равно</option>
                              <option value="gt">больше</option>
                              <option value="lt">меньше</option>
                              <option value="empty">пусто</option>
                              <option value="notEmpty">не пусто</option>
                            </select>
                          </label>
                          <label className="field">
                            Тип сравнения
                            <select
                              value={c.type}
                              onChange={(e) =>
                                updateStep({
                                  config: { ...c, type: e.target.value as typeof c.type },
                                })
                              }
                            >
                              <option value="text">Текст</option>
                              <option value="number">Число</option>
                              <option value="date">Дата ISO</option>
                            </select>
                          </label>
                        </div>
                        {!['empty', 'notEmpty'].includes(c.op) && (
                          <label className="field">
                            Значение
                            <input
                              value={c.value}
                              placeholder={c.type === 'date' ? '2026-01-31' : 'Условие отбора'}
                              onChange={(e) =>
                                updateStep({ config: { ...c, value: e.target.value } })
                              }
                            />
                          </label>
                        )}
                        <p className="field-help">
                          Нужно несколько условий? Добавьте фильтры последовательно. Некорректные
                          ячейки не проходят числовое сравнение.
                        </p>
                      </>
                    );
                  })()}
                {selectedStep.config.kind === 'select' &&
                  (() => {
                    const c = selectedStep.config;
                    return (
                      <>
                        <div className="field">
                          <span>Столбцы на выходе</span>
                          <div className="column-checks">
                            {inputColumns.length ? (
                              inputColumns.map((col) => (
                                <label key={col}>
                                  <input
                                    type="checkbox"
                                    checked={c.columns.includes(col)}
                                    onChange={(e) =>
                                      updateStep({
                                        config: {
                                          ...c,
                                          columns: e.target.checked
                                            ? [...c.columns, col]
                                            : c.columns.filter((x) => x !== col),
                                        },
                                      })
                                    }
                                  />
                                  <span>{col}</span>
                                </label>
                              ))
                            ) : (
                              <p>Подключите входную таблицу.</p>
                            )}
                          </div>
                        </div>
                        <p className="field-help">
                          Порядок выбора задаёт порядок столбцов. Уберите отметку и выберите снова,
                          чтобы переместить столбец в конец.
                        </p>
                        <div className="selected-columns">
                          {c.columns.map((col, i) => (
                            <span key={col}>
                              {i + 1}. {col}
                            </span>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                {selectedStep.config.kind === 'aggregate' &&
                  (() => {
                    const c = selectedStep.config;
                    return (
                      <>
                        <div className="field">
                          <span>Группировать по</span>
                          <div className="column-checks compact">
                            {inputColumns.map((col) => (
                              <label key={col}>
                                <input
                                  type="checkbox"
                                  checked={c.groupBy.includes(col)}
                                  onChange={(e) =>
                                    updateStep({
                                      config: {
                                        ...c,
                                        groupBy: e.target.checked
                                          ? [...c.groupBy, col]
                                          : c.groupBy.filter((x) => x !== col),
                                      },
                                    })
                                  }
                                />
                                <span>{col}</span>
                              </label>
                            ))}
                          </div>
                          <small>Без группировки — итог по всей таблице.</small>
                        </div>
                        <div className="metrics-heading">
                          МЕТРИКИ<span>{c.metrics.length}</span>
                        </div>
                        {c.metrics.map((metric, i) => (
                          <div className="metric-config" key={i}>
                            <div className="metric-config-top">
                              <span>Метрика {i + 1}</span>
                              <button
                                aria-label={`Удалить метрику ${i + 1}`}
                                disabled={c.metrics.length === 1}
                                onClick={() =>
                                  updateStep({
                                    config: {
                                      ...c,
                                      metrics: c.metrics.filter((_, index) => index !== i),
                                    },
                                  })
                                }
                              >
                                <X size={13} />
                              </button>
                            </div>
                            <select
                              aria-label={`Операция метрики ${i + 1}`}
                              value={metric.op}
                              onChange={(e) =>
                                updateStep({
                                  config: {
                                    ...c,
                                    metrics: c.metrics.map((m, index) =>
                                      index === i
                                        ? { ...m, op: e.target.value as typeof metric.op }
                                        : m,
                                    ),
                                  },
                                })
                              }
                            >
                              <option value="count">Количество</option>
                              <option value="sum">Сумма</option>
                              <option value="avg">Среднее</option>
                              <option value="min">Минимум</option>
                              <option value="max">Максимум</option>
                            </select>
                            <select
                              aria-label={`Столбец метрики ${i + 1}`}
                              value={metric.column}
                              onChange={(e) =>
                                updateStep({
                                  config: {
                                    ...c,
                                    metrics: c.metrics.map((m, index) =>
                                      index === i ? { ...m, column: e.target.value } : m,
                                    ),
                                  },
                                })
                              }
                            >
                              <option value="">
                                {metric.op === 'count' ? 'Все строки (*)' : 'Выберите столбец'}
                              </option>
                              {inputColumns.map((col) => (
                                <option key={col}>{col}</option>
                              ))}
                            </select>
                            <input
                              aria-label={`Имя результата метрики ${i + 1}`}
                              value={metric.alias}
                              placeholder="Имя выходного столбца"
                              onChange={(e) => {
                                if (e.target.value.trim())
                                  updateStep({
                                    config: {
                                      ...c,
                                      metrics: c.metrics.map((m, index) =>
                                        index === i
                                          ? { ...m, alias: e.target.value.slice(0, 160) }
                                          : m,
                                      ),
                                    },
                                  });
                              }}
                            />
                          </div>
                        ))}
                        <button
                          className="add-metric"
                          disabled={c.metrics.length >= 20}
                          onClick={() =>
                            updateStep({
                              config: {
                                ...c,
                                metrics: [
                                  ...c.metrics,
                                  {
                                    op: 'count',
                                    column: '',
                                    alias: `Количество_${c.metrics.length + 1}`,
                                  },
                                ],
                              },
                            })
                          }
                        >
                          <Plus size={13} /> Добавить метрику
                        </button>
                        <label className="field">
                          Некорректные числа
                          <select
                            value={c.invalid}
                            onChange={(e) =>
                              updateStep({
                                config: { ...c, invalid: e.target.value as typeof c.invalid },
                              })
                            }
                          >
                            <option value="reject">Остановить шаг с ошибкой</option>
                            <option value="skip">Пропустить и предупредить</option>
                          </select>
                        </label>
                        <p className="field-help">
                          Пустые значения исключаются из числовых итогов. Пустая группа сохраняется.
                          Сумма/среднее пустой группы — пустое значение.
                        </p>
                      </>
                    );
                  })()}
                {selectedStep.config.kind === 'export' &&
                  (() => {
                    const c = selectedStep.config;
                    return (
                      <>
                        <label className="field">
                          Имя файла
                          <input
                            value={c.filename}
                            onChange={(e) => {
                              if (e.target.value.trim())
                                updateStep({
                                  config: { ...c, filename: e.target.value.slice(0, 160) },
                                });
                            }}
                          />
                        </label>
                        <label className="field">
                          Разделитель
                          <select
                            value={c.delimiter}
                            onChange={(e) =>
                              updateStep({
                                config: { ...c, delimiter: e.target.value as typeof c.delimiter },
                              })
                            }
                          >
                            <option value=";">Точка с запятой (;)</option>
                            <option value=",">Запятая (,)</option>
                            <option value={'\t'}>Табуляция</option>
                            <option value="|">Вертикальная черта (|)</option>
                          </select>
                        </label>
                        <div className="export-note">
                          <ShieldCheck size={20} />
                          <strong>Готово для Excel</strong>
                          <p>
                            UTF-8 с BOM, кавычки, CRLF и защита от формул. Опасные начальные символы
                            получают апостроф.
                          </p>
                        </div>
                        {selectedResult?.status === 'success' && (
                          <button
                            className="button download-button"
                            onClick={() => void downloadResult(selected)}
                          >
                            <ArrowDownToLine size={15} /> Скачать {format(selectedResult.count)}{' '}
                            строк
                          </button>
                        )}
                      </>
                    );
                  })()}
                {selectedStep.config.kind !== 'source' && (
                  <div className="connection-editor">
                    <span>ВХОДНАЯ ТАБЛИЦА</span>
                    <select
                      aria-label="Входной шаг"
                      value={incoming?.source || ''}
                      onChange={(e) => {
                        const without = {
                          ...graph,
                          edges: graph.edges.filter((edge) => edge.target !== selected),
                        };
                        if (!e.target.value) commit(without);
                        else if (canConnect(without, e.target.value, selected))
                          commit({
                            ...without,
                            edges: [
                              ...without.edges,
                              { id: crypto.randomUUID(), source: e.target.value, target: selected },
                            ],
                          });
                        else setError('Эта связь создаёт цикл или несовместима.');
                      }}
                    >
                      <option value="">Не подключено</option>
                      {graph.nodes
                        .filter((n) => n.id !== selected && n.config.kind !== 'export')
                        .map((n) => (
                          <option value={n.id} key={n.id}>
                            {n.label}
                          </option>
                        ))}
                    </select>
                    <small>Связь можно задать здесь без перетаскивания.</small>
                  </div>
                )}
              </fieldset>
              <div className="inspector-bottom">
                <button disabled={!!busy} onClick={removeStep}>
                  <Trash2 size={14} /> Удалить шаг
                </button>
                <span>#{graph.nodes.findIndex((n) => n.id === selected) + 1}</span>
              </div>
            </>
          ) : (
            <div className="inspector-empty">
              <Settings2 size={26} />
              <h3>Настройте действие</h3>
              <p>Нажмите на шаг в маршруте или добавьте новый из библиотеки.</p>
            </div>
          )}
        </aside>
      </div>
      <section className="results-panel">
        <div className="results-tabs">
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
            <Columns3 size={14} /> Данные шага{' '}
            {selectedResult?.status === 'success' && <span>{format(selectedResult.count)}</span>}
          </button>
          <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
            <Clock3 size={14} /> Журнал выполнения{' '}
            {results.length > 0 && <span>{results.length}</span>}
          </button>
          <div className="results-target">
            <span className={`tiny-kind kind-${selectedStep?.config.kind || 'source'}`} />
            {selectedStep?.label || 'Выберите шаг'}
            {ms !== null && <small>{format(ms)} мс / весь маршрут</small>}
          </div>
        </div>
        {tab === 'preview' ? (
          selectedResult ? (
            selectedResult.status === 'success' ? (
              <>
                <div className="preview-toolbar">
                  <span>
                    {selectedResult.columns.length} столбцов · {format(selectedResult.count)} строк
                    {selectedResult.warnings.length
                      ? ' · ' + selectedResult.warnings.join(' ')
                      : ''}
                  </span>
                  <button disabled={!!busy} onClick={() => void downloadResult(selected)}>
                    <ArrowDownToLine size={13} /> Скачать данные шага
                  </button>
                </div>
                <div className="preview-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        {selectedResult.columns.map((col, i) => (
                          <th key={i}>
                            {col}
                            <span>
                              {selectedResult.types[i] === 'number'
                                ? 'Число'
                                : selectedResult.types[i] === 'date'
                                  ? 'Дата'
                                  : 'Текст'}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(page || selectedResult.preview).map((row, index) => (
                        <tr key={index}>
                          <td className="row-index">{offset + index + 1}</td>
                          {row.map((cell, col) => (
                            <td
                              key={col}
                              title={cell}
                              className={selectedResult.types[col] === 'number' ? 'numeric' : ''}
                            >
                              {cell || <span className="null-cell">—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {selectedResult.count === 0 && (
                    <div className="zero-rows">Шаг выполнен. Подходящих строк нет.</div>
                  )}
                </div>
                <div className="preview-pagination">
                  <span>
                    Строки {selectedResult.count ? offset + 1 : 0}–
                    {Math.min(offset + 50, selectedResult.count)} из {format(selectedResult.count)}
                  </span>
                  <div>
                    <button
                      disabled={offset === 0 || !!busy}
                      onClick={() => setOffset((v) => Math.max(0, v - 50))}
                    >
                      ← Назад
                    </button>
                    <button
                      disabled={offset + 50 >= selectedResult.count || !!busy}
                      onClick={() => setOffset((v) => v + 50)}
                    >
                      Далее →
                    </button>
                  </div>
                  <span>Результат реального выполнения · {format(selectedResult.ms)} мс</span>
                </div>
              </>
            ) : (
              <div className="result-error">
                <span className="error-dot" />
                <div>
                  <h3>
                    {selectedResult.status === 'error' ? 'Шаг завершился ошибкой' : 'Шаг пропущен'}
                  </h3>
                  <p>{selectedResult.error}</p>
                </div>
              </div>
            )
          ) : (
            <div className="results-empty">
              <div className="empty-run-icon">
                <Play size={19} />
              </div>
              <div>
                <h3>Результат появится после запуска</h3>
                <p>Нажмите «Запустить», чтобы обработать CSV и увидеть данные каждого шага.</p>
              </div>
              <button
                className="text-button"
                disabled={!!busy || !ready}
                onClick={() => void run()}
              >
                Выполнить маршрут <ArrowRight size={15} />
              </button>
            </div>
          )
        ) : (
          <div className="run-log">
            {results.length ? (
              results.map((r) => (
                <button
                  key={r.nodeId}
                  className={`log-entry ${r.status}`}
                  onClick={() => {
                    setSelected(r.nodeId);
                    setTab('preview');
                  }}
                >
                  <span>{r.status === 'success' ? <Check size={14} /> : <X size={14} />}</span>
                  <strong>{graph.nodes.find((n) => n.id === r.nodeId)?.label}</strong>
                  <span>
                    {r.status === 'success'
                      ? `${format(r.count)} строк · ${r.columns.length} столбцов`
                      : r.error}
                  </span>
                  <small>{format(r.ms)} мс</small>
                  <ArrowUpRight size={13} />
                </button>
              ))
            ) : (
              <div className="log-empty">Журнал появится после запуска маршрута.</div>
            )}
          </div>
        )}
      </section>
      <footer className="app-footer">
        <span>
          <GitBranch size={12} /> МАРШРУТ <i /> VERSION 0.1.0-RC.1
        </span>
        <span>JSON хранит схему, CSV — только на вашем устройстве.</span>
        <button
          onClick={async () => {
            try {
              await del(storageKey);
              setSaved('Сохранённая копия удалена');
              setNotice(
                'Локальная копия удалена. При следующем изменении маршрут сохранится снова.',
              );
            } catch {
              setError('Не удалось удалить локальную копию.');
            }
          }}
        >
          Удалить сохранённую копию
        </button>
      </footer>
      {showHelp && (
        <div className="help-backdrop" onClick={closeHelp}>
          <div
            className="help-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeHelp();
              if (e.key === 'Tab') {
                e.preventDefault();
                (e.currentTarget.querySelector('button') as HTMLButtonElement)?.focus();
              }
            }}
          >
            <button autoFocus aria-label="Закрыть справку" onClick={closeHelp}>
              <X size={20} />
            </button>
            <p className="eyebrow">ОТ ТАБЛИЦЫ К РЕЗУЛЬТАТУ</p>
            <h2 id="help-title">
              Пусть рутина
              <br />
              идёт по маршруту.
            </h2>
            <p>
              Источник читает локальный CSV. Фильтр отбирает строки. Выбор столбцов меняет состав и
              порядок полей. Группировка считает метрики. Выгрузка скачивает результат.
            </p>
            <p>
              У каждого действия один вход, выход можно разветвлять. Циклы и объединение нескольких
              входов запрещены. Связи задаются точками на карточках или полем «Входной шаг» в
              инспекторе — оно доступно с клавиатуры.
            </p>
            <p>
              После изменения настроек результаты сбрасываются: запустите маршрут снова. На каждом
              успешном шаге доступны предварительный просмотр с пагинацией и CSV. Ошибка
              останавливает зависимую ветку; независимые ветки выполняются.
            </p>
            <p>
              Схема JSON содержит только настройки. Локальная копия в IndexedDB содержит и исходные
              CSV; на общем устройстве удаляйте её. Автоматический запуск после восстановления не
              выполняется.
            </p>
            <p>
              До 40 шагов, 120 связей, 50 МБ на источники, 500 000 строк / 200 столбцов / 5 млн
              ячеек в одном CSV. Всё в памяти. Числа — JavaScript number; точная финансовая
              арифметика не заявляется. Для дат используйте ISO. Строки формул при экспорте получают
              апостроф.
            </p>
            <p>
              Ctrl+Z / Ctrl+Shift+Z — история схемы. Ctrl+Enter — выполнить. История хранится в
              текущей вкладке, до 60 изменений; исходные файлы не версионируются. Код и сетевые
              запросы внутри шагов не исполняются.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
