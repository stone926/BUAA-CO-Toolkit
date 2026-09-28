import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaveActions } from '../../waveform/webview/actions';
import { WaveStore } from '../../waveform/webview/store';

const renderer = vi.hoisted(() => ({ renderWaves: vi.fn(), renderWaveOverlay: vi.fn() }));

vi.mock('../../waveform/webview/theme', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../waveform/webview/rulerRenderer', () => ({ measurementLabel: () => '' }));
vi.mock('../../waveform/webview/waveRenderer', () => ({
  waveFont: () => '12px monospace',
  ...renderer,
  snap: (value: number) => value
}));

class FakeCanvas {
  width = 0;
  height = 0;
  className = '';
  readonly style = { width: '', height: '', cursor: '' };
  readonly classList = { add: vi.fn(), remove: vi.fn() };
  readonly handlers = new Map<string, (event: Record<string, unknown>) => void>();
  readonly context = { setTransform: vi.fn(), measureText: () => ({ width: 112 }) };

  addEventListener(name: string, handler: (event: Record<string, unknown>) => void): void {
    this.handlers.set(name, handler);
  }

  setPointerCapture(_pointerId: number): void {}

  getContext(_kind: string): typeof this.context {
    return this.context;
  }

  dispatch(name: string, event: Record<string, unknown>): void {
    this.handlers.get(name)?.(event);
  }
}

describe('waveform canvas overlay invalidation', () => {
  let canvases: FakeCanvas[];
  let frames: Array<() => void>;
  let store: WaveStore;
  let canvas: { resize(width: number, height: number): void; element: FakeCanvas };
  let fakeWindow: { devicePixelRatio: number };

  beforeEach(async () => {
    canvases = [];
    frames = [];
    vi.stubGlobal('document', {
      createElement: () => {
        const element = new FakeCanvas();
        canvases.push(element);
        return element;
      }
    });
    fakeWindow = { devicePixelRatio: 1 };
    vi.stubGlobal('window', fakeWindow);
    store = new WaveStore(() => undefined, (callback) => frames.push(callback));
    // Interaction only needs a loaded-document sentinel; drawing is recorded by the renderer spies.
    store.data = {} as WaveStore['data'];
    const actions = new WaveActions(store);
    // Runtime imports keep the Node-only test tsconfig from compiling browser modules without DOM types.
    const canvasModule = '../../waveform/webview/waveCanvas';
    const paneModule = '../../waveform/webview/wavePane';
    const { WaveCanvas } = await vi.importActual<Record<string, new (...args: any[]) => any>>(canvasModule);
    const { WavePane } = await vi.importActual<Record<string, new (...args: any[]) => any>>(paneModule);
    const tooltip = { hide: vi.fn(), schedule: vi.fn() };
    canvas = new WaveCanvas(store, actions, () => ({ monoFamily: 'monospace' }), tooltip, {
      onContextMenu: vi.fn(),
      onDragRange: vi.fn()
    });
    canvas.resize(100, 50);

    const pane = Object.assign(Object.create(WavePane.prototype), {
      store, canvas, ruler: { render: vi.fn() }, overview: { render: vi.fn() }
    });
    store.onChange((dirty) => pane.render(dirty));
    store.invalidate('waves');
    flush();
    renderer.renderWaves.mockClear();
    renderer.renderWaveOverlay.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function flush(): void {
    frames.splice(0).forEach((frame) => frame());
  }

  it('refreshes only the transparent layer while hovering and dragging a range', () => {
    const visibleRows = vi.spyOn(store.rows, 'visibleRows');
    canvases[0].dispatch('pointermove', { offsetX: 20, offsetY: 8, clientX: 20, clientY: 8 });
    flush();
    canvases[0].dispatch('pointerdown', { button: 0, pointerId: 1, offsetX: 20, offsetY: 8, ctrlKey: false, metaKey: false });
    canvases[0].dispatch('pointermove', { offsetX: 40, offsetY: 8, clientX: 40, clientY: 8 });
    flush();
    canvases[0].dispatch('pointermove', { offsetX: 50, offsetY: 8, clientX: 50, clientY: 8 });
    flush();

    expect(renderer.renderWaves).not.toHaveBeenCalled();
    expect(renderer.renderWaveOverlay).toHaveBeenCalledTimes(3);
    expect(visibleRows).not.toHaveBeenCalled();
  });

  it('refreshes both layers for waves, resize, and device-pixel-ratio changes', () => {
    store.invalidate('waves');
    flush();
    expect(renderer.renderWaves).toHaveBeenCalledTimes(1);
    expect(renderer.renderWaveOverlay).toHaveBeenCalledTimes(1);
    expect(canvases.map((element) => [element.width, element.height])).toEqual([[100, 50], [100, 50]]);

    canvas.resize(120, 60);
    store.invalidate('waves');
    flush();
    expect(canvases.map((element) => [element.width, element.height])).toEqual([[120, 60], [120, 60]]);

    fakeWindow.devicePixelRatio = 2;
    store.invalidate('overlay');
    flush();
    expect(renderer.renderWaves).toHaveBeenCalledTimes(3);
    expect(renderer.renderWaveOverlay).toHaveBeenCalledTimes(3);
    expect(canvases.map((element) => [element.width, element.height])).toEqual([[240, 120], [240, 120]]);
  });
});
