// @index waveform-webview-main — 波形 Webview 入口：加载样式并在 #app 上启动应用
import './styles.css';
import { WaveformApp } from './app';

const root = document.getElementById('app');
if (root) {
  new WaveformApp(root);
}
