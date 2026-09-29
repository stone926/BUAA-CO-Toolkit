// @index verilog-p7-return — Public macroscopic-PC history drives a real handler-return interrupt
import { renderResourceTemplate } from '../../templates/templateRegistry';
import { p7ExternalInterruptAckAddress, p7ProbeEretPoisonAddress, p7Timer0Ctrl } from '../../courseTesting/p7Hardware';

interface ReturnScenario {
  id: number;
  kind: string;
  triggerPc?: number;
  armAddress?: number;
  armValue?: number;
  afterReturnOf?: { scenarioId: number; eretPc: number };
}

export function buildP7ReturnInterruptBlock(scenarios: readonly ReturnScenario[], ackPc: number): string {
  const [first, second] = scenarios;
  if (scenarios.length !== 2 || first?.kind !== 'external' || second?.kind !== 'external'
    || second.afterReturnOf?.scenarioId !== first.id) {
    throw new Error('A return-boundary probe requires an ordered pair of external interrupts.');
  }
  const hex = (value: number | undefined): string => {
    if (!Number.isSafeInteger(value) || value === undefined || value < 0 || value > 0xffffffff) {
      throw new Error('A return-boundary probe contains an invalid public PC or marker.');
    }
    return `32'h${value.toString(16).padStart(8, '0')}`;
  };
  return [renderResourceTemplate('verilog/p7_return_block.v', {
    firstId: first.id, secondId: second.id,
    firstTarget: hex(first.triggerPc), armAddress: hex(first.armAddress), armValue: hex(first.armValue),
    eretPc: hex(second.afterReturnOf.eretPc), ackAddress: hex(p7ExternalInterruptAckAddress), ackPc: hex(ackPc),
    poisonAddress: hex(p7ProbeEretPoisonAddress)
  }), renderResourceTemplate('verilog/p7_probe_mmio_observer.v', {
    timer0CtrlAddress: hex(p7Timer0Ctrl),
    externalInterruptMmioMaxAddress: hex(p7ExternalInterruptAckAddress + 0xf)
  })].join('\n');
}
