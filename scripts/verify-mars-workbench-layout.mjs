// Layout regressions use measured production DOM geometry, including real tab clicks.
import assert from 'node:assert/strict';

export async function verifyWorkbenchLayout({ call, evaluate, navigate, click, screenshot }) {
  const measurements = [];
  const geometry = () => evaluate(`(() => {
    const box = selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x:r.x, y:r.y, width:r.width, height:r.height };
    };
    const controls = [...document.querySelectorAll('.inspection-header button, .inspection .pane-footer button')]
      .filter(node=>node.getClientRects().length).map(node=>({name:node.textContent, left:node.getBoundingClientRect().left, right:node.getBoundingClientRect().right}));
    return { pane:box('.inspection'), header:box('.inspection-header'), dialog:box('dialog'), controls,
      pageWidth:document.documentElement.scrollWidth, viewport:innerWidth, scrollY };
  })()`);
  for (const [width, height, theme] of [[1440,1040], [1280,900], [1000,700], [900,900], [520,900], [320,700], [1440,900,'light'], [520,900,'hc'], [320,700,'hc-light']]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:false });
    await navigate(theme ? `?theme=${theme}` : '');
    for (const expanded of [false, true]) {
      if (expanded) await click('展开阅读');
      const tabs = [];
      for (const name of ['控制台', '内存', '符号', '系统服务', '控制台']) {
        await click(name);
        tabs.push({ name, ...await geometry() });
      }
      measurements.push({ width, height, expanded, tabs });
    }
  }
  for (const { width, height, expanded, tabs } of measurements) {
    const first = tabs[0];
    for (const tab of tabs) {
      for (const key of ['x','y','width','height']) {
        assert.ok(Math.abs(tab.pane[key] - first.pane[key]) < 1,
          `${width}x${height} ${expanded ? 'expanded' : 'inline'} ${tab.name}: pane ${key} changed from ${first.pane[key]} to ${tab.pane[key]}`);
      }
      assert.ok(tab.pageWidth <= tab.viewport, `${width}px ${tab.name}: page must not overflow horizontally`);
      for (const control of tab.controls) {
        assert.ok(control.left >= tab.pane.x - 1 && control.right <= tab.pane.x + tab.pane.width + 1,
          `${width}px ${tab.name}: ${control.name} must remain within the pane`);
      }
    }
  }
  console.log('PASS stable inspection geometry across four tabs, inline/expanded and 320–1440px viewports');

  await call('Emulation.setDeviceMetricsOverride', { width:1000, height:700, deviceScaleFactor:1, mobile:false });
  await navigate();
  await evaluate(`window.__workbenchFixture.setState({console:Array.from({length:200},(_,i)=>'Output '+i).join('\\n')})`);
  const settle = () => evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await settle();
  for (const [tab, selector] of [['控制台','.console-output'], ['内存','.memory-panel .table-scroll'], ['系统服务','.syscall-scroll']]) {
    await click(tab);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollTop=180`);
    await click('展开阅读');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollTop`), 180, `${tab} expansion preserves reading position`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollTop=220`);
    await click('还原布局'); await settle();
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollTop`), 220, `${tab} restoration preserves reading position`);
  }
  await click('控制台');
  assert.equal(await evaluate(`document.querySelector('.console-output').scrollTop`), 220, 'hidden console position survives other tabs being expanded');
  await click('内存');
  assert.equal(await evaluate(`document.querySelector('.memory-panel .table-scroll').scrollTop`), 220, 'hidden memory position survives other tabs being expanded');
  await click('展开阅读');
  await evaluate(`document.querySelector('.memory-panel .table-scroll').scrollTop=260`);
  await call('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await call('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await settle();
  assert.equal(await evaluate(`document.querySelector('.memory-panel .table-scroll').scrollTop`), 260, 'Escape preserves reading position');
  await click('系统服务');
  await evaluate(`(()=>{document.querySelector('.syscall-scroll').scrollTop=9999;const search=document.querySelector('input[type=search]');search.value='integer';search.dispatchEvent(new Event('input'));})()`);
  assert.equal(await evaluate(`document.querySelector('.syscall-scroll').scrollTop`), 0, 'new search starts at the first matching service');
  await click('符号');
  await evaluate(`(()=>{const link=[...document.querySelectorAll('.symbols-panel tbody tr')].find(row=>row.textContent.includes('greeting')).querySelector('button');link.focus();link.click();})()`);
  assert.equal(await evaluate(`document.activeElement===document.querySelector('.memory-panel .table-scroll')`), true, 'data symbol transfers keyboard focus into memory');
  await click('符号'); await click('展开阅读');
  await evaluate(`(()=>{const link=[...document.querySelectorAll('.symbols-panel tbody tr')].find(row=>row.textContent.includes('main')).querySelector('button');link.focus();link.click();})()`);
  await settle();
  assert.equal(await evaluate(`!document.querySelector('dialog').open && document.activeElement===document.querySelector('.listing-scroll')`), true, 'code symbol closes dialog and transfers focus into listing');
  console.log('PASS reading position survives expansion, restoration, Escape and hidden tab relocation');
}
