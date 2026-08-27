import { describe, expect, it } from 'vitest';
import { handleMipsEngineCliValue } from '../../mips/cli/protocol';

/**
 * Protocol surface of the phase 2/3 executor and device operations. The
 * conformance harness reaches the production engine only through this boundary,
 * so the response shape, the fixed-width hex convention and the stable error
 * codes are all part of the contract.
 */

function request(operation: string, fields: Record<string, unknown> = {}): unknown {
  return { protocolVersion: 1, requestId: 'test', operation, ...fields };
}

function textSegment(words: readonly string[], baseAddress = '0x00003000'): unknown {
  return { name: 'text', baseAddress, words: [...words] };
}

/** `ori $1,$0,5` / `ori $2,$0,3` / `add $3,$1,$2` / `sw $3,0($0)` / halt loop. */
const p3Program = [
  '0x34010005', '0x34020003', '0x00221820', '0xac030000', '0x1000ffff', '0x00000000'
];

describe('MIPS engine CLI executor surface', () => {
  it('advertises separate catalog, executor and device revisions', () => {
    const response = handleMipsEngineCliValue(request('describe')) as {
      ok: boolean;
      result: Record<string, unknown>;
    };
    expect(response.ok).toBe(true);
    expect(response.result.operations).toEqual(expect.arrayContaining([
      'machine.execute', 'device.cycleVector'
    ]));
    expect(response.result.executor).toMatchObject({
      id: 'builtin-ts-executor',
      semanticsRevision: 1,
      eventSchemaRevision: 1,
      traceProjectionRevision: 1,
      coverageRevision: 1,
      profiles: ['P3', 'P4', 'P5', 'P6', 'P7']
    });
    expect(response.result.device).toMatchObject({
      id: 'builtin-ts-course-timer',
      cycleContractRevision: 2
    });
    // The ISA catalog identity must stay untouched by the executor addition.
    expect(response.result.engine).toMatchObject({ id: 'builtin-ts-isa', semanticsRevision: 1 });
  });

  it('executes a P3 program and reports fixed-width state with a course trace', () => {
    const response = handleMipsEngineCliValue(request('machine.execute', {
      profile: 'P3',
      segments: [textSegment(p3Program)],
      collectTrace: true
    })) as { ok: boolean; result: Record<string, never> };

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      status: 'halted',
      haltReason: 'course-halt-loop',
      instructions: 5,
      haltPc: '0x00003010',
      finalStateDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      imageFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(response.result.trace).toEqual([
      '@00003000: $1 <= 00000005',
      '@00003004: $2 <= 00000003',
      '@00003008: $3 <= 00000008',
      '@0000300C: *00000000 <= 00000008'
    ]);
    const finalState = response.result.finalState as unknown as {
      gpr: string[]; hi: string; hiDefined: boolean;
      dataWords: Array<{ address: string; value: string }>;
    };
    expect(finalState.gpr[3]).toBe('0x00000008');
    expect(finalState.hiDefined).toBe(false);
    expect(finalState.dataWords).toEqual([{ address: '0x00000000', value: '0x00000008' }]);
  });

  it('produces an identical digest for an identical request', () => {
    const payload = { profile: 'P6', segments: [textSegment(p3Program)] };
    const first = handleMipsEngineCliValue(request('machine.execute', payload)) as {
      result: { finalStateDigest: string };
    };
    const second = handleMipsEngineCliValue(request('machine.execute', payload)) as {
      result: { finalStateDigest: string };
    };
    expect(first.result.finalStateDigest).toBe(second.result.finalStateDigest);
  });

  it('reports coverage bins and checkpoints on request', () => {
    const response = handleMipsEngineCliValue(request('machine.execute', {
      profile: 'P6',
      segments: [textSegment(p3Program)],
      collectCoverage: true,
      checkpointInterval: 2
    })) as { result: { coverage: Array<{ id: string; hits: number }>; checkpoints: unknown[] } };
    const ids = response.result.coverage.map((bin) => bin.id);
    expect(ids).toEqual(expect.arrayContaining([
      'execution.instruction.P6.add',
      'execution.instruction.P6.ori',
      'execution.address-boundary.data.first'
    ]));
    expect(response.result.checkpoints.length).toBeGreaterThan(0);
  });

  it('fails closed on malformed execute requests with stable codes', () => {
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ profile: 'P9', segments: [textSegment(['0x00000000'])] }, 'invalid-request', /profile is invalid/],
      [{ profile: 'P3', segments: [] }, 'invalid-request', /segments must contain/],
      [
        { profile: 'P3', segments: [textSegment(['0x00000000'], '0x00003001')] },
        'invalid-request', /word-aligned/
      ],
      [
        { profile: 'P3', segments: [textSegment(['0xzz000000'])] },
        'invalid-request', /8 hex digits/
      ],
      [
        { profile: 'P3', segments: [textSegment(['0x00000000'])], enabledLayers: [] },
        'invalid-request', /enabledLayers/
      ],
      [
        { profile: 'P3', segments: [textSegment(['0x00000000'])], deviceSchedule: { kind: 'always' } },
        'invalid-request', /deviceSchedule.kind/
      ],
      [
        { profile: 'P3', segments: [textSegment(['0x00000000'])], maxSteps: 0 },
        'invalid-request', /maxSteps/
      ]
    ];
    for (const [fields, code, message] of cases) {
      const response = handleMipsEngineCliValue(request('machine.execute', fields)) as {
        ok: boolean; error: { code: string; message: string };
      };
      expect(response.ok, JSON.stringify(fields)).toBe(false);
      expect(response.error.code, JSON.stringify(fields)).toBe(code);
      expect(response.error.message, JSON.stringify(fields)).toMatch(message);
    }
  });

  it('rejects unknown execute fields', () => {
    const response = handleMipsEngineCliValue(request('machine.execute', {
      profile: 'P3',
      segments: [textSegment(['0x00000000'])],
      unexpected: 1
    })) as { ok: boolean; error: { code: string; message: string } };
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('invalid-request');
    expect(response.error.message).toMatch(/unknown fields: unexpected/);
  });

  it('surfaces an unloaded instruction word as a structured out-of-domain result', () => {
    // COURSE-P7-UNLOADED-IM-001: `ori $1,$0,0x3100` / `jr $1` / `nop` jumps inside
    // the legal IM range to a word the image never provided. That must fail closed
    // as out-of-domain, not become AdEL and not synthesize a nop.
    const response = handleMipsEngineCliValue(request('machine.execute', {
      profile: 'P7',
      segments: [textSegment(['0x34013100', '0x00200008', '0x00000000'])]
    })) as {
      ok: boolean;
      result: { status: string; diagnostic: { code: string; reason: string; pc: string; contractId: string } };
    };
    expect(response.ok).toBe(true);
    expect(response.result.status).toBe('out-of-domain');
    expect(response.result.diagnostic).toMatchObject({
      code: 'mips-core.exec.unloaded-instruction',
      reason: 'unloaded-instruction',
      pc: '0x00003100',
      contractId: 'COURSE-P7-UNLOADED-IM-001'
    });
  });

  it('lets an explicit exploratory policy zero-fill the same unloaded word', () => {
    const response = handleMipsEngineCliValue(request('machine.execute', {
      profile: 'P7',
      segments: [textSegment(['0x34013100', '0x00200008', '0x00000000'])],
      unloadedInstruction: 'synthetic-zero',
      maxSteps: 8
    })) as { ok: boolean; result: { status: string } };
    expect(response.ok).toBe(true);
    // Zero-filled words decode as `nop`, so the run now exhausts its budget instead.
    expect(response.result.status).toBe('step-limit');
  });
});

describe('MIPS engine CLI device cycle vector', () => {
  it('reproduces the official one-shot Timer sequence edge by edge', () => {
    // Official RTL: a WE cycle never advances the state machine, so the two
    // writes consume two edges before IDLE -> LOAD can happen.
    const steps = [
      { kind: 'write', device: 'timer0', register: 'preset', value: '0x00000003' },
      { kind: 'write', device: 'timer0', register: 'ctrl', value: '0x00000009' },
      ...Array.from({ length: 7 }, () => ({ kind: 'tick', cycles: 1 }))
    ];
    const response = handleMipsEngineCliValue(request('device.cycleVector', { steps })) as {
      ok: boolean;
      result: Array<{
        kind: string;
        timer0: { state: string; count: string; irq: boolean };
        hardwareInterrupts: string;
      }>;
    };
    expect(response.ok).toBe(true);
    const observed = response.result.map((entry) => ({
      state: entry.timer0.state,
      count: entry.timer0.count,
      irq: entry.timer0.irq
    }));
    expect(observed).toEqual([
      { state: 'idle', count: '0x00000000', irq: false },   // write preset
      { state: 'idle', count: '0x00000000', irq: false },   // write ctrl (EN|IM)
      { state: 'idle', count: '0x00000000', irq: false },   // WE edge 1 consumed
      { state: 'idle', count: '0x00000000', irq: false },   // WE edge 2 consumed
      { state: 'load', count: '0x00000000', irq: false },   // IDLE -> LOAD
      { state: 'cnt', count: '0x00000003', irq: false },    // LOAD -> CNT, COUNT = PRESET
      { state: 'cnt', count: '0x00000002', irq: false },
      { state: 'cnt', count: '0x00000001', irq: false },
      { state: 'int', count: '0x00000000', irq: true }      // COUNT <= 1 -> INT
    ]);
    expect(response.result.at(-1)!.hardwareInterrupts).toBe('0x00000001');
  });

  it('rejects a COUNT write before the device observes it', () => {
    const response = handleMipsEngineCliValue(request('device.cycleVector', {
      steps: [{ kind: 'write', device: 'timer0', register: 'count', value: '0x00000001' }]
    })) as { ok: boolean; result: Array<{ fault?: string; timer0: { count: string } }> };
    expect(response.ok).toBe(true);
    expect(response.result[0].fault).toBe('count-write');
    expect(response.result[0].timer0.count).toBe('0x00000000');
  });

  it('reads a Timer register without advancing any state', () => {
    const response = handleMipsEngineCliValue(request('device.cycleVector', {
      steps: [
        { kind: 'write', device: 'timer1', register: 'ctrl', value: '0xffffffff' },
        { kind: 'read', device: 'timer1', register: 'ctrl' },
        { kind: 'read', device: 'timer1', register: 'ctrl' }
      ]
    })) as { ok: boolean; result: Array<{ readValue?: string; timer1: { state: string } }> };
    // CTRL only stores its low four bits (`load = Addr[3:2]==0 ? {28'h0, Din[3:0]} : Din`).
    expect(response.result[1].readValue).toBe('0x0000000f');
    expect(response.result[2].readValue).toBe('0x0000000f');
    expect(response.result[2].timer1.state).toBe('idle');
  });

  it('fails closed on malformed device vectors', () => {
    for (const steps of [[], [{ kind: 'nope' }], [{ kind: 'write', device: 'timer2', register: 'ctrl', value: '0x00000000' }]]) {
      const response = handleMipsEngineCliValue(request('device.cycleVector', { steps })) as {
        ok: boolean; error: { code: string };
      };
      expect(response.ok, JSON.stringify(steps)).toBe(false);
      expect(response.error.code, JSON.stringify(steps)).toBe('invalid-request');
    }
  });
});
