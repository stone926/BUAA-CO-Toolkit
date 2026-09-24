// @index waveform-webview-dom — Webview 小型 DOM 工具：元素构建、类名切换、事件监听释放（遵守 CSP，不使用 style 属性字符串）

export type Child = Node | string | null | undefined | false;

export interface ElementOptions {
  className?: string;
  title?: string;
  text?: string;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  html?: string;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly Child[] = []
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) {
    element.className = options.className;
  }
  if (options.title) {
    element.title = options.title;
  }
  if (options.text !== undefined) {
    element.textContent = options.text;
  }
  if (options.html !== undefined) {
    // Only for static, extension-authored markup (icons); never for dump content.
    element.innerHTML = options.html;
  }
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    element.setAttribute(name, value);
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) {
    element.dataset[name] = value;
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      element.append(child);
    }
  }
  return element;
}

export function toggleClass(element: Element, className: string, enabled: boolean): void {
  if (element.classList.contains(className) !== enabled) {
    element.classList.toggle(className, enabled);
  }
}

export function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

export interface Disposable {
  dispose(): void;
}

export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Window | Document,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions
): Disposable {
  target.addEventListener(type, handler as EventListener, options);
  return { dispose: () => target.removeEventListener(type, handler as EventListener, options) };
}

/** Pixel size of a canvas' CSS box, and a backing store scaled for the device pixel ratio. */
export function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number): { ctx: CanvasRenderingContext2D; dpr: number } {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const deviceWidth = Math.max(1, Math.round(width * dpr));
  const deviceHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
    canvas.width = deviceWidth;
    canvas.height = deviceHeight;
  }
  const cssWidth = `${width}px`;
  const cssHeight = `${height}px`;
  if (canvas.style.width !== cssWidth) {
    canvas.style.width = cssWidth;
  }
  if (canvas.style.height !== cssHeight) {
    canvas.style.height = cssHeight;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, dpr };
}
