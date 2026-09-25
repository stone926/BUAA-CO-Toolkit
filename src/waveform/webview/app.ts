// @index waveform-webview-app — Webview 组装与消息处理：布局装配、主题/尺寸变化重绘、宿主消息（init/进度/文档/trace/定位/快捷键/错误）分派

import { isWaveformShortcut, type HostToWebviewMessage } from '../model/protocol';
import { WaveActions } from './actions';
import { closeContextMenu } from './contextMenu';
import { h } from './dom';
import { HostChannel } from './hostChannel';
import { HelpOverlay, installKeyboard, runShortcut, type KeyboardTargets } from './keyboard';
import { SignalBrowser } from './signalBrowser';
import { Sidebar } from './sidebar';
import { LoadOverlay, StatusBar } from './statusBar';
import { DirtyFlag, WaveStore } from './store';
import { observeTheme, Palette, readPalette } from './theme';
import { Toolbar } from './toolbar';
import { Tooltip } from './tooltip';
import { TracePanel } from './tracePanel';
import { WavePane } from './wavePane';

export class WaveformApp {
  private readonly host = new HostChannel();
  private readonly store: WaveStore;
  private readonly actions: WaveActions;
  private palette: Palette = readPalette();
  private readonly toolbar: Toolbar;
  private readonly sidebar: Sidebar;
  private readonly browser: SignalBrowser;
  private readonly pane: WavePane;
  private readonly status: StatusBar;
  private readonly overlay: LoadOverlay;
  private readonly help = new HelpOverlay();
  private readonly tooltip = new Tooltip();
  private readonly keys: KeyboardTargets;

  constructor(root: HTMLElement) {
    this.store = new WaveStore((state) => this.host.saveState(state), (callback) => requestAnimationFrame(callback));
    this.actions = new WaveActions(this.store);
    const palette = (): Palette => this.palette;
    const notify = (message: string): void => this.status.notify(message);
    this.status = new StatusBar(this.store);
    this.browser = new SignalBrowser(this.store, this.actions, this.host, notify);
    const trace = new TracePanel(this.store, this.actions);
    this.sidebar = new Sidebar(this.store, this.browser, trace);
    this.pane = new WavePane(this.store, this.actions, this.host, palette, this.tooltip);
    this.toolbar = new Toolbar(this.store, this.actions, this.host, {
      toggleSidebar: () => this.sidebar.toggle(),
      showHelp: () => this.help.toggle(),
      notify
    });
    this.overlay = new LoadOverlay(this.store, this.host);
    root.append(
      this.toolbar.element,
      h('div', { className: 'main' }, [this.sidebar.element, this.pane.element]),
      this.status.element,
      this.overlay.element,
      this.help.element
    );
    this.store.onChange((dirty) => this.render(dirty));
    this.keys = {
      store: this.store,
      actions: this.actions,
      focusSearch: () => {
        this.sidebar.show('signals');
        requestAnimationFrame(() => this.browser.focusSearch());
      },
      focusTime: () => this.toolbar.focusTimeInput(),
      toggleHelp: () => this.help.toggle(),
      dismiss: () => {
        closeContextMenu();
        this.tooltip.hide();
        if (this.help.visible) {
          this.help.hide();
          return true;
        }
        return this.pane.cancelInteraction();
      }
    };
    installKeyboard(this.keys);
    observeTheme(() => {
      this.palette = readPalette();
      this.store.invalidate();
    });
    window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => this.onMessage(event.data));
    window.addEventListener('blur', () => this.tooltip.hide());
    this.store.loading = { loaded: 0, total: 0 };
    this.store.invalidate();
    this.host.ready();
  }

  private render(dirty: ReadonlySet<DirtyFlag>): void {
    this.toolbar.render(dirty);
    this.sidebar.render(dirty);
    this.pane.render(dirty);
    this.status.render(dirty);
    this.overlay.render();
  }

  private onMessage(message: HostToWebviewMessage): void {
    if (!message || typeof message !== 'object') {
      return;
    }
    switch (message.type) {
      case 'init':
        this.store.fileName = message.fileName;
        document.title = message.fileName;
        this.store.setSavedState(message.state);
        this.store.invalidate();
        return;
      case 'progress':
        this.store.loading = { loaded: message.loadedBytes, total: message.totalBytes };
        this.store.error = undefined;
        this.store.invalidate('status');
        return;
      case 'document':
        this.store.setDocument(message.data, message.reload);
        if (!message.reload) {
          this.pane.focus();
        }
        return;
      case 'trace':
        this.store.setTrace(message.trace);
        return;
      case 'revealTime':
        this.actions.setCursor(message.time);
        this.actions.centerOn(this.store.cursor);
        return;
      case 'addSignals': {
        const indexes = message.paths.map((path) => this.store.varIndex(path)).filter((index) => index >= 0);
        this.actions.addSignals(indexes);
        return;
      }
      case 'shortcut':
        if (isWaveformShortcut(message.shortcut)) {
          runShortcut(this.keys, message.shortcut, document.activeElement);
        }
        return;
      case 'error':
        this.store.loading = undefined;
        this.store.error = { message: message.message, canRetry: message.canRetry };
        this.store.invalidate('status');
        return;
      default:
        return;
    }
  }
}
