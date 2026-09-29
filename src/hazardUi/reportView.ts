// @index hazard-ui — 内置流水线冒险报告的无宿主 HTML 渲染
import { escapeHtml } from '../language/common/util';
import { renderResourceTemplate } from '../templates/templateRegistry';
import type { HazardClassCoverage, HazardReport, HazardReportEvent, HazardStopReason } from '../hazardAnalysis/reportTypes';

export interface HazardReportMetadata {
  readonly inputLabel: string;
  readonly generatedAt?: string;
}

const classLabels: Readonly<Record<string, string>> = {
  cal_rr: '寄存器计算', cal_ri: '立即数计算', br_r1: '单寄存器分支', br_r2: '双寄存器分支',
  mv_fr: '读取 HI/LO', mv_to: '写入 HI/LO', load: '访存读取', store: '访存写入',
  mul_div: '乘除法', lui: '加载立即数', jal: '跳转链接', jalr: '寄存器链接跳转', jr: '寄存器跳转'
};

const eventLabels: Readonly<Record<HazardReportEvent['kind'], string>> = {
  forward: '转发', stall: '阻塞', zero: '$0 写入', priority: '转发优先级', hilo: 'HI/LO'
};

const stopLabels: Readonly<Record<HazardStopReason, { title: string; detail: string; tone: string }>> = {
  'program-end': { title: '正常结束', detail: '程序顺序执行到输入代码末端。', tone: 'ok' },
  'course-halt-loop': { title: '正常结束', detail: '识别到课程程序的结束循环。', tone: 'ok' },
  'step-limit': { title: '达到步数上限', detail: '统计仅覆盖已经执行的部分；可以检查程序是否停在预期的结束循环。', tone: 'warn' },
  'out-of-domain': { title: '离开可分析范围', detail: '执行遇到当前模型无法继续处理的情况；请查看分析提示，统计仅覆盖停止前的部分。', tone: 'warn' },
  cancelled: { title: '分析已取消', detail: '下方结果来自取消前已执行的指令。', tone: 'warn' },
  'engine-error': { title: '分析中断', detail: '引擎未能完成执行，请查看警告并检查输入。', tone: 'bad' }
};

/** Render a validated native report. All report and metadata text is escaped before it enters markup. */
export function renderHazardReport(report: HazardReport, metadata: HazardReportMetadata, nonce: string): string {
  if (!/^[A-Za-z0-9+/_=-]{16,}$/.test(nonce)) {
    throw new Error('Invalid Webview CSP nonce');
  }
  const stop = stopLabels[report.stopReason];
  const summary = report.summary;
  const body = `
    <div class="report-shell hazard-report"><header class="page-header hazard-header">
      <div class="hero-copy">
        <p class="eyebrow">BUAA CO · 流水线分析</p>
        <h1>冲突冒险报告</h1>
        <p class="subtitle">按课程 AT 法观察程序中的转发与阻塞，快速找出尚未覆盖的冲突组合。</p>
        <div class="hero-meta"><span class="badge neutral">${escapeHtml(report.profile)} · ${escapeHtml(report.model)} 模型</span><span class="input-name" title="${escapeHtml(metadata.inputLabel)}">${escapeHtml(metadata.inputLabel)}</span>${metadata.generatedAt ? `<time>${escapeHtml(metadata.generatedAt)}</time>` : ''}</div>
      </div>
      <div class="hero-actions" aria-label="报告操作">
        <button type="button" class="primary" data-action="reanalyze">重新分析</button>
        <button type="button" class="secondary" data-action="openInput">打开输入</button>
        <button type="button" class="secondary" data-action="openJson">打开 JSON</button>
      </div>
    </header>
    <nav class="jump-nav" aria-label="报告目录"><a href="#coverage-heading">覆盖概览</a><a href="#matrix-heading">分类矩阵</a><a href="#events-heading">事件实例</a><a href="#improvements-heading">改进建议</a></nav>
    <main>
      <section class="summary overview" aria-label="分析摘要">
        <div class="metric status-card"><span class="card-kicker">执行状态</span><strong><span class="badge ${stop.tone}">${stop.title}</span></strong><span>${stop.detail}</span><span class="status-pc">停止 PC · ${hexAddress(report.stopPc)}</span></div>
        <div class="metric metric-card"><span class="card-kicker">已执行指令</span><strong>${formatCount(summary.instructions)}</strong><span>${formatCount(summary.cycles)} 周期</span></div>
        <div class="metric metric-card"><span class="card-kicker">数据阻塞</span><strong>${formatCount(summary.dataStallCycles)}</strong><span>乘除单元等待 ${formatCount(summary.multiplyDivideStallCycles)} 周期</span></div>
        <div class="metric metric-card"><span class="card-kicker">已记录事件</span><strong>${formatCount(report.events.length + report.omittedEvents)}</strong><span>${report.omittedEvents > 0 ? `其中 ${formatCount(report.omittedEvents)} 条未展示` : '可在下方筛选查看'}</span></div>
      </section>
      <section class="section coverage-section" aria-labelledby="coverage-heading">
        <div class="section-head"><div><p class="eyebrow">01 / 覆盖概览</p><h2 id="coverage-heading">冲突覆盖</h2></div><p>覆盖率基于课程模型的转发、阻塞元组上限。有效率表示转发值与当时寄存器值不同的比例。</p></div>
        <div class="coverage-grid">
          ${coverageCard('转发覆盖', summary.forwardCovered, summary.forwardExpected, summary.forwardCoverage, summary.forwardGrade, 'forward')}
          ${coverageCard('阻塞覆盖', summary.stallCovered, summary.stallExpected, summary.stallCoverage, summary.stallGrade, 'stall')}
          <article class="coverage-card validity"><div class="card-top"><span>转发有效率</span><span class="small-label">${formatCount(summary.validForwardEvents)} / ${formatCount(summary.forwardEvents)} 次</span></div><strong>${percent(summary.forwardValidRate)}</strong><progress class="meter" aria-label="转发有效率" value="${meterWidth(summary.forwardValidRate)}" max="100">${percent(summary.forwardValidRate)}</progress><p>只有能改变消费者结果的转发，才计入有效转发。</p></article>
        </div>
      </section>
      <section class="section" aria-labelledby="matrix-heading">
        <div class="section-head"><div><p class="eyebrow">02 / 分类矩阵</p><h2 id="matrix-heading">按指令类别查看</h2></div><p>行内按“消费者 ← 生产者”排列；空白上限表示该模型没有对应的考核元组。</p></div>
        ${coverageTable(report.classCoverage)}
      </section>
      <section class="section" aria-labelledby="events-heading">
        <div class="section-head"><div><p class="eyebrow">03 / 动态证据</p><h2 id="events-heading">事件实例</h2></div><p>选择类型、有效性，或按指令、寄存器与 PC 搜索。</p></div>
        ${eventSection(report.events, report.omittedEvents)}
      </section>
      <section class="section lower-grid" aria-label="下一步和课程说明">
        ${suggestionSection(report.classCoverage, report.warnings)}
        <article class="info-panel"><p class="eyebrow">AT 方法 · 怎样读这些数字</p><h2>时机决定是否冲突</h2><p>指令在 D 级读取依赖时，比较消费者需要数据的 Tuse 与生产者产生数据的 Tnew。若数据尚未就绪，D 级需要阻塞；就绪后可从相应流水级转发。</p><p>一次转发被标为“有效”，表示转发值不同于当时寄存器中的旧值。覆盖率只统计课程模型定义的元组，因此单纯增加指令条数不一定增加覆盖。</p><p class="fine-print">P7 按 P6 冲突模型统计。报告反映输入程序的执行路径，不等同于对 CPU 实现正确性的判定。</p></article>
      </section>
    </main></div>`;
  return renderResourceTemplate('hazard/report.html', {
    nonce,
    css: `${renderResourceTemplate('webview/report.css', {})}\n${renderResourceTemplate('hazard/report.css', {})}`,
    script: renderResourceTemplate('hazard/report.js', {}),
    body
  });
}

function coverageCard(label: string, covered: number, expected: number, rate: number, grade: number | null, kind: string): string {
  return `<article class="coverage-card ${kind}"><div class="card-top"><span>${label}</span><span class="small-label">${formatCount(covered)} / ${formatCount(expected)} 元组</span></div><strong>${percent(rate)}</strong><progress class="meter" aria-label="${label}" value="${meterWidth(rate)}" max="100">${percent(rate)}</progress><p>课程参考分 ${grade === null ? '—' : formatNumber(grade, 1)} <span class="hint">· 仅反映覆盖强度</span></p></article>`;
}

function coverageTable(rows: readonly HazardClassCoverage[]): string {
  if (rows.length === 0) return '<div class="empty-state">当前模型没有可展示的分类覆盖数据。</div>';
  return `<div class="matrix-controls"><label>显示类别<select id="matrix-filter"><option value="all">全部类别</option><option value="observed">有覆盖</option><option value="gap">有缺口</option></select></label><span id="matrix-count" class="result-count" role="status" aria-live="polite" aria-atomic="true"></span></div><div class="table-scroll" role="region" aria-label="指令类别覆盖矩阵，可水平滚动" tabindex="0"><table class="coverage-table"><thead><tr><th scope="col">消费者 ← 生产者</th><th scope="col">转发</th><th scope="col">阻塞</th><th scope="col">参考分</th></tr></thead><tbody>${rows.map((row) => {
    const forward = cellCoverage(row.forwardCovered, row.forwardExpected, 'forward');
    const stall = cellCoverage(row.stallCovered, row.stallExpected, 'stall');
    const grades = `${gradeText(row.forwardGrade)} / ${gradeText(row.stallGrade)}`;
    const observed = row.forwardCovered + row.stallCovered > 0;
    const gap = row.forwardCovered < row.forwardExpected || row.stallCovered < row.stallExpected;
    return `<tr data-observed="${observed}" data-gap="${gap}"><th scope="row"><span class="pair-label">${escapeHtml(classLabels[row.consumerClass] ?? row.consumerClass)} <span aria-hidden="true">←</span> ${escapeHtml(classLabels[row.producerClass] ?? row.producerClass)}</span><code>${escapeHtml(row.pair)}</code></th><td>${forward}</td><td>${stall}</td><td class="grades">${grades}</td></tr>`;
  }).join('')}</tbody></table></div><p id="matrix-empty" class="empty-state" role="status" hidden>当前筛选条件下没有类别。请选择其他类别。</p>`;
}

function cellCoverage(covered: number, expected: number, kind: string): string {
  if (expected === 0) return '<span class="na">—</span>';
  const rate = covered / expected;
  return `<div class="cell-coverage"><span>${formatCount(covered)} <span class="denominator">/ ${formatCount(expected)}</span></span><progress class="mini-meter ${kind}" value="${meterWidth(rate)}" max="100">${percent(rate)}</progress></div>`;
}

function eventSection(events: readonly HazardReportEvent[], omitted: number): string {
  if (events.length === 0) return '<div class="empty-state">这次执行尚未记录冒险事件。尝试加入相邻的生产者与消费者指令，然后重新分析。</div>';
  const controls = `<div class="event-controls"><label>事件类型<select id="event-kind"><option value="all">全部类型</option>${(Object.entries(eventLabels) as Array<[HazardReportEvent['kind'], string]>).map(([kind, label]) => `<option value="${kind}">${label}</option>`).join('')}</select></label><label>有效性<select id="event-valid"><option value="all">全部事件</option><option value="valid">有效</option><option value="invalid">无效</option><option value="unknown">未判定</option></select></label><label class="search-label">搜索事件<input id="event-search" type="search" placeholder="指令、寄存器或 PC" autocomplete="off" spellcheck="false"></label><button type="button" class="secondary reset-filters" id="event-reset" hidden>清除筛选</button><span id="event-count" class="result-count" role="status" aria-live="polite" aria-atomic="true"></span></div>`;
  const cards = events.map((event) => {
    const validity = event.valid === true ? 'valid' : event.valid === false ? 'invalid' : 'unknown';
    const origin = [event.producer, event.producerOrder === undefined ? undefined : `#${formatCount(event.producerOrder + 1)}`].filter(Boolean).join(' ');
    const target = `${event.consumer} #${formatCount(event.consumerOrder + 1)}`;
    const detail = eventDetail(event);
    const search = [event.consumer, event.producer, event.register, event.role, hexAddress(event.consumerPc), eventLabels[event.kind], validityLabel(validity), detail].filter(Boolean).join(' ').toLocaleLowerCase();
    const eventKind = Object.prototype.hasOwnProperty.call(eventLabels, event.kind) ? event.kind : 'forward';
    return `<li class="event-card" data-kind="${eventKind}" data-valid="${validity}" data-search="${escapeHtml(search)}"><div class="event-heading"><span class="badge neutral event-type ${eventKind}">${eventLabels[eventKind]}</span><span class="badge ${validity === 'valid' ? 'ok' : validity === 'invalid' ? 'warn' : 'neutral'} event-state">${validityLabel(validity)}</span><code class="event-pc">${hexAddress(event.consumerPc)}</code></div><div class="event-flow">${origin ? `<code>${escapeHtml(origin)}</code><span aria-label="到">→</span>` : ''}<code>${escapeHtml(target)}</code></div><div class="event-detail">${escapeHtml(detail)}</div></li>`;
  }).join('');
  return `${controls}<ol id="event-list" class="event-list">${cards}</ol><p id="event-empty" class="empty-state" role="status" hidden>没有符合筛选条件的事件。可清除筛选后查看全部事件。</p>${omitted > 0 ? `<p class="fine-print">为保持报告流畅，另有 ${formatCount(omitted)} 条事件未展示；JSON 中提供本次分析的完整统计。</p>` : ''}`;
}

function eventDetail(event: HazardReportEvent): string {
  const parts: string[] = [`周期 ${formatCount(event.cycle)}`];
  if (event.register) parts.push(`寄存器 ${event.register}`);
  if (event.role) parts.push(`源操作数 ${event.role}`);
  if (event.sourceStage && event.destinationStage) parts.push(`${event.sourceStage} → ${event.destinationStage} 级`);
  if (event.interval !== undefined) parts.push(`阻塞间隔 ${event.interval}`);
  if (parts.length === 0) parts.push('流水线相关事件');
  return parts.join(' · ');
}

function validityLabel(value: string): string {
  return value === 'valid' ? '有效' : value === 'invalid' ? '无效' : '未判定';
}

function suggestionSection(rows: readonly HazardClassCoverage[], warnings: readonly string[]): string {
  const misses = rows.flatMap((row) => {
    const label = `${classLabels[row.consumerClass] ?? row.consumerClass} ← ${classLabels[row.producerClass] ?? row.producerClass}`;
    const result: string[] = [];
    if (row.forwardExpected > row.forwardCovered) result.push(`${label}：转发 ${row.forwardCovered}/${row.forwardExpected}`);
    if (row.stallExpected > row.stallCovered) result.push(`${label}：阻塞 ${row.stallCovered}/${row.stallExpected}`);
    return result;
  });
  const ordered = misses.slice(0, 6);
  const list = ordered.length > 0 ? `<ul class="suggestion-list">${ordered.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>${misses.length > ordered.length ? `<p class="fine-print">还有 ${formatCount(misses.length - ordered.length)} 类未满覆盖，可在上方矩阵逐项查看。</p>` : ''}<p class="fine-print">可调整指令顺序、依赖寄存器与执行路径，补充生产者和消费者之间的不同距离。</p>` : '<p>当前模型定义的分类元组已覆盖。可用事件筛选检查每类的具体执行证据。</p>';
  return `<article class="info-panel next-panel"><p class="eyebrow">04 / 下一步</p><h2 id="improvements-heading">优先补充这些组合</h2>${list}${warnings.length > 0 ? `<div class="warnings"><h3>分析提示</h3><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>` : ''}</article>`;
}

function gradeText(value: number | null): string {
  return value === null ? '—' : formatNumber(value, 0);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}

function meterWidth(value: number | null): number {
  return value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value * 100));
}

function hexAddress(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}
