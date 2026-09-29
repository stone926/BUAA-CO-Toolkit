import { describe, expect, it } from 'vitest';
import { renderToolchainReport } from '../../webview/toolchainReport';

describe('toolchain report', () => {
  it('summarizes checks and emphasizes actionable failures safely', () => {
    const page = renderToolchainReport([
      { name: 'Java', ok: true, detail: '17.0.1' },
      { name: 'MARS', ok: false, detail: '未配置 <jar>', suggestion: '设置 co.toolchain.mars' }
    ]);

    expect(page).toContain('检查总数');
    expect(page).toContain('待处理');
    expect(page).toContain('可用');
    expect(page).toContain('设置 co.toolchain.mars');
    expect(page).toContain('未配置 &lt;jar&gt;');
    expect(page).toContain('待处理项会附上配置或安装建议');
    expect(page).not.toContain('未配置 <jar>');
  });

  it('explains when the current project has no required external tools', () => {
    const page = renderToolchainReport([]);
    expect(page).toContain('当前项目没有需要检查的外部工具');
    expect(page).toContain('>0<');
  });
});
