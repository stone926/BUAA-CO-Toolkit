import { describe, expect, it } from 'vitest';
import { CommandProbe, defaultPythonCommand, firstWorkingCommand, pythonCandidates } from '../python';

describe('python command resolution', () => {
  it('orders candidates by platform', () => {
    expect(pythonCandidates('win32')).toEqual(['python', 'py', 'python3']);
    expect(pythonCandidates('darwin')).toEqual(['python3', 'python']);
    expect(pythonCandidates('linux')).toEqual(['python3', 'python']);
  });

  it('defaults to python3 off Windows and python on Windows', () => {
    expect(defaultPythonCommand('win32')).toBe('python');
    expect(defaultPythonCommand('darwin')).toBe('python3');
    expect(defaultPythonCommand('linux')).toBe('python3');
  });

  it('returns the first candidate the probe accepts', async () => {
    const probed: string[] = [];
    const probe: CommandProbe = async (command) => {
      probed.push(command);
      return command === 'python3';
    };
    const found = await firstWorkingCommand(pythonCandidates('darwin'), probe);
    expect(found).toBe('python3');
    // python3 is first on darwin, so it short-circuits before trying python.
    expect(probed).toEqual(['python3']);
  });

  it('falls back to a later candidate when the preferred one is missing', async () => {
    const probed: string[] = [];
    const probe: CommandProbe = async (command) => {
      probed.push(command);
      return command === 'python';
    };
    const found = await firstWorkingCommand(pythonCandidates('darwin'), probe);
    expect(found).toBe('python');
    expect(probed).toEqual(['python3', 'python']);
  });

  it('returns undefined when no candidate is available', async () => {
    const probe: CommandProbe = async () => false;
    expect(await firstWorkingCommand(pythonCandidates('linux'), probe)).toBeUndefined();
  });
});
