import { describe, expect, it } from 'vitest';
import {
  handleMipsEngineCliValue,
  mipsEngineCliMaximumBatch,
  mipsEngineCliProtocolVersion
} from '../../mips/cli/protocol';

const requiredP7 = { profile: 'P7', enabledLayers: ['required'] };

function request(operation: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: mipsEngineCliProtocolVersion,
    requestId: `request-${operation}`,
    operation,
    ...fields
  };
}

describe('MIPS engine CLI protocol', () => {
  it('describes a fingerprinted, versioned ISA service', () => {
    const response = handleMipsEngineCliValue(request('describe'));

    expect(response).toMatchObject({
      protocolVersion: 1,
      ok: true,
      result: {
        engine: { id: 'builtin-ts-isa', semanticsRevision: 1 },
        catalog: { schemaRevision: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        maximumBatch: mipsEngineCliMaximumBatch
      }
    });
  });

  it('encodes and decodes fixed-width words without signed JSON ambiguity', () => {
    const encoded = handleMipsEngineCliValue(request('isa.encode', {
      mnemonic: 'add',
      operands: { rd: 9, rs: 10, rt: 11 }
    }));
    expect(encoded).toMatchObject({ ok: true, result: { mnemonic: 'add', word: '0x014b4820' } });

    const decoded = handleMipsEngineCliValue(request('isa.decode', {
      word: '0x014b4820',
      scope: requiredP7
    }));
    expect(decoded).toMatchObject({
      ok: true,
      result: {
        word: '0x014b4820',
        runtimeRecognized: true,
        exactMnemonic: 'add',
        canonicalMnemonic: 'add'
      }
    });
  });

  it('keeps runtime recognition separate from canonical reserved fields', () => {
    const decoded = handleMipsEngineCliValue(request('isa.decode', {
      word: '0x014b48e0',
      scope: requiredP7
    }));
    expect(decoded).toMatchObject({
      ok: true,
      result: {
        runtimeRecognized: true,
        exactMnemonic: 'add'
      }
    });
    expect(decoded.result).not.toHaveProperty('canonicalMnemonic');
  });

  it('processes independent batches and fails closed on unknown fields', () => {
    const batch = handleMipsEngineCliValue(request('isa.decodeBatch', {
      words: ['0x00000000', '0xfc000000'],
      scope: requiredP7
    }));
    expect(batch).toMatchObject({
      ok: true,
      result: [
        { exactMnemonic: 'nop', canonicalMnemonic: 'nop' },
        { runtimeRecognized: false }
      ]
    });

    const invalid = handleMipsEngineCliValue(request('describe', { unexpected: true }));
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'invalid-request' }
    });
  });

  it('rejects malformed scopes, words, operands, and oversized batches', () => {
    expect(handleMipsEngineCliValue(request('isa.decode', {
      word: '0x1',
      scope: requiredP7
    }))).toMatchObject({ ok: false, error: { code: 'invalid-request' } });

    expect(handleMipsEngineCliValue(request('isa.decode', {
      word: '0x00000000',
      scope: { profile: 'P8', enabledLayers: ['required'] }
    }))).toMatchObject({ ok: false, error: { code: 'invalid-request' } });

    expect(handleMipsEngineCliValue(request('isa.encode', {
      mnemonic: 'add',
      operands: { rd: 32 }
    }))).toMatchObject({ ok: false, error: { code: 'isa-encode-invalid' } });

    expect(handleMipsEngineCliValue(request('isa.decodeBatch', {
      words: new Array(mipsEngineCliMaximumBatch + 1).fill('0x00000000'),
      scope: requiredP7
    }))).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  it('returns stable protocol errors for malformed envelopes and operations', () => {
    expect(handleMipsEngineCliValue({})).toMatchObject({
      requestId: 'invalid-request',
      ok: false,
      error: { code: 'protocol-version-unsupported' }
    });
    expect(handleMipsEngineCliValue(request('unknown'))).toMatchObject({
      ok: false,
      error: { code: 'unsupported-operation' }
    });
  });
});
