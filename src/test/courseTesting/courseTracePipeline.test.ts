import { describe, expect, it, vi } from 'vitest';
import { CourseTracePipeline } from '../../courseTesting/pipeline/courseTracePipeline';

describe('CourseTracePipeline full-stage injection', () => {
  it('delegates every course-trace stage through the injected dependency', async () => {
    const stages = {
      createCase: vi.fn(async () => ({ case: true })),
      prepareProgram: vi.fn(async () => ({ ok: true })),
      runOracle: vi.fn(async () => ({ ok: true, preflight: { ok: true } })),
      runDut: vi.fn(async () => ({ ok: true })),
      runLogisimDut: vi.fn(async () => ({ result: { ok: true } })),
      compareTraces: vi.fn(() => ({ matched: true })),
      recordOracle: vi.fn(async () => undefined),
      updateArtifacts: vi.fn(async () => undefined),
      copyArtifact: vi.fn(async () => undefined)
    };
    const pipeline = new CourseTracePipeline(stages as never);

    await pipeline.createCase({} as never, {} as never);
    await pipeline.prepareProgram({} as never, {} as never, {} as never);
    await pipeline.runOracle({} as never, {} as never, {} as never);
    await pipeline.runDut({} as never, {} as never);
    await pipeline.runLogisimDut({} as never, {} as never, {} as never, '3000', {} as never);
    pipeline.compareTraces([], []);
    await pipeline.recordOracle({} as never, {} as never, {} as never, {} as never);
    await pipeline.updateArtifacts({} as never, {} as never, {} as never);
    await pipeline.copyArtifact({} as never, {} as never, {} as never, {} as never, {} as never);

    expect(stages.createCase).toHaveBeenCalledTimes(1);
    expect(stages.prepareProgram).toHaveBeenCalledTimes(1);
    expect(stages.runOracle).toHaveBeenCalledTimes(1);
    expect(stages.runDut).toHaveBeenCalledTimes(1);
    expect(stages.runLogisimDut).toHaveBeenCalledTimes(1);
    expect(stages.compareTraces).toHaveBeenCalledTimes(1);
    expect(stages.recordOracle).toHaveBeenCalledTimes(1);
    expect(stages.updateArtifacts).toHaveBeenCalledTimes(1);
    expect(stages.copyArtifact).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a required stage was not injected', async () => {
    const pipeline = new CourseTracePipeline({});
    expect(() => pipeline.compareTraces([], [])).toThrow(/not injected/);
    expect(() => pipeline.prepareProgram({} as never, {} as never)).toThrow(/not injected/);
  });

  it('still owns image-policy validation without any injected stage', () => {
    const pipeline = new CourseTracePipeline({});
    const issues = pipeline.validateProgram('P3', {} as never, 0x3000);
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });
});
