// @index hazard-detail-view — Full-stream operand/priority statistics and explicit effect-sensitivity scope.
import { escapeHtml } from '../language/common/util';
import type { HazardDetailGroup, HazardReport } from '../hazardAnalysis/reportTypes';

export function renderHazardDetails(report: HazardReport): string {
  const details = report.detailed;
  if (!details) return '<section class="section" aria-labelledby="detail-heading"><h2 id="detail-heading">完整冒险统计</h2><p class="empty-state">旧版报告未采集端口、生产者组合与效果敏感性。请重新分析；缺少的数据不表示零次发生。</p></section>';
  const groups: Array<[string, HazardDetailGroup]> = [
    ['转发', details.forward], ['$0 丢弃写', details.zero], ['多写入者优先级', details.priority], ['HI/LO', details.hiLo]
  ];
  return `<section class="section" aria-labelledby="detail-heading">
    <div class="section-head"><div><p class="eyebrow">完整动态流</p><h2 id="detail-heading">端口与优先级细分</h2></div><p>计数覆盖全部已执行事件，不受下方事件实例的展示上限影响。组合数是已观察种类，不是覆盖率分母。</p></div>
    <div class="table-scroll" role="region" aria-label="完整冒险统计，可水平滚动" tabindex="0"><table class="hazard-detail-table"><thead><tr><th scope="col">类别</th><th scope="col">事件总数</th><th scope="col">新旧值不同</th><th scope="col">效果改变</th><th scope="col">效果不变</th><th scope="col">未评估</th></tr></thead><tbody>${groups.map(([label, group]) => `<tr><th scope="row">${label}</th><td>${n(group.events)}</td><td>${n(group.validEvents)}</td><td>${n(group.observability.observable)}</td><td>${n(group.observability.masked)}</td><td>${n(group.observability.unknown)}</td></tr>`).join('')}</tbody></table></div>
    <p class="fine-print">效果检查只替换当前消费者的一个源操作数，比较该指令的架构效果；不等于整个程序的故障检出率，也不证明真实流水线时序正确。设备或不支持的语义标为未评估。</p>
    <p>同时阻塞原因：<strong>${n(details.stallCauses.events)}</strong> 次。分别记录每个参与端口和生产者；同一周期可有多个原因，因此此数不等于数据阻塞周期数。</p>
    <div class="detail-groups">${groups.map(([label, group]) => keyList(label, group.keys, group.keysTruncated,
      `其中新旧值不同的组合 ${group.validKeysTruncated ? '至少 ' : ''}${n(group.validKeys.length)} 种`)).join('')}
      ${keyList('同时阻塞原因', details.stallCauses.keys, details.stallCauses.keysTruncated)}</div>
    <p class="fine-print">组合记录具体助记符、源端口与动态间隔；优先级组合还包含旧、新生产者的身份。gap 表示两条相关指令之间实际执行的指令数。完整键和值差子集可通过“打开 JSON”查看。</p>
  </section>`;
}

export function renderHazardExecution(report: HazardReport): string {
  const execution = report.execution;
  if (!execution) return '<p class="fine-print execution-context">旧版报告未记录外部中断上下文；不能据此判断是否重放了原用例调度。</p>';
  const origin = execution.source === 'case'
    ? `已验证的保存用例${execution.caseId ? ` ${escapeHtml(execution.caseId)}` : ''}` : '独立输入文件';
  const interrupts = execution.externalInterrupts;
  const schedule = interrupts.length
    ? `已载入 ${n(interrupts.length)} 个外部中断目标：${interrupts.slice(0, 8).map((item) => `<code>0x${item.victimPc.toString(16).padStart(8, '0')} / 第 ${item.occurrence} 次</code>`).join('、')}${interrupts.length > 8 ? '（其余见 JSON）' : ''}`
    : report.profile === 'P7' ? '未配置外部 IRQ；分析路径不包含外部中断注入' : '无外部中断调度';
  return `<p class="execution-context">${origin} · ${schedule}。</p>${report.profile === 'P7' ? '<p class="fine-print">Timer 没有周期时间线时不参与分析；保存用例的 IRQ 重放也不代表整个 P7 hybrid 探针套件。</p>' : ''}`;
}

function keyList(label: string, keys: readonly string[], truncated: boolean, extra = ''): string {
  return `<details class="detail-keys"><summary>${label}：已观察${truncated ? '至少 ' : ''}${n(keys.length)} 种组合${extra ? ` · ${extra}` : ''}</summary>${truncated ? '<p class="fine-print">组合清单达到保留上限，未列出不等于未发生；上方事件计数仍完整。</p>' : ''}${keys.length ? `<pre>${keys.map(escapeHtml).join('\n')}</pre>` : '<p class="fine-print">本次执行未观察到此类组合。</p>'}</details>`;
}

function n(value: number): string { return new Intl.NumberFormat('zh-CN').format(value); }
