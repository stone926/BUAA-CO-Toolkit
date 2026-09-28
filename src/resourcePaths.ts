// @index resource-paths — bundled host/server 与源码测试共享的安装资源定位
import * as path from 'path';

// This module lives directly in src/ or out/. Host/server bundles and resource-
// consuming helper bundles also live directly in out/, preserving this anchor.
export const extensionRoot = path.resolve(__dirname, '..');

export function resourcePath(...segments: string[]): string {
  return path.join(extensionRoot, 'resources', ...segments);
}
