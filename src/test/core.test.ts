import { describe, it, expect } from 'vitest';
import { canTransition, testStatusFor, branchNameFor, type ExperimentRecord, type TestRunRecord } from '../model.js';
import { isPathInside, validateRelativePath, touchesGitMetadata } from '../paths.js';
import { validatePanelMessage } from '../messages.js';
import { pickPort } from '../ports.js';

describe('lifecycle transitions', () => {
  it('follows the PRD state machine', () => {
    expect(canTransition('creating', 'active')).toBe(true);
    expect(canTransition('active', 'applying')).toBe(true);
    expect(canTransition('applying', 'applied')).toBe(true);
    expect(canTransition('applied', 'active')).toBe(false);
    expect(canTransition('archived', 'active')).toBe(false);
    expect(branchNameFor('e1', 'v2')).toBe('branchlab/e1/v2');
  });
});

describe('test status derivation (FR-05)', () => {
  const exp = { testCommand: 'npm test' } as ExperimentRecord;
  const run: TestRunRecord = {
    id: 'r1', variantId: 'v1', command: 'npm test', fingerprint: 'abc',
    startedAt: 1, endedAt: 2, exitCode: 0, status: 'passed',
  };
  it('no command means not-configured, never passed', () => {
    expect(testStatusFor({ testCommand: null } as ExperimentRecord, [run], 'v1', 'abc')).toBe('not-configured');
  });
  it('fresh pass stays passed; any content change makes it stale', () => {
    expect(testStatusFor(exp, [run], 'v1', 'abc')).toBe('passed');
    expect(testStatusFor(exp, [run], 'v1', 'xyz')).toBe('stale');
    expect(testStatusFor(exp, [], 'v1', 'abc')).toBe('never-run');
    expect(testStatusFor(exp, [{ ...run, status: 'failed', exitCode: 3 }], 'v1', 'abc')).toBe('failed');
  });
});

describe('path guards (AC-14)', () => {
  it('containment works and traversal is rejected', () => {
    expect(isPathInside('/repo', '/repo/src/a.ts')).toBe(true);
    expect(isPathInside('/repo', '/repo2/a.ts')).toBe(false);
    expect(validateRelativePath('src/a.ts')).toBe('src/a.ts');
    expect(validateRelativePath('../escape.ts')).toBeNull();
    expect(validateRelativePath('/abs/path.ts')).toBeNull();
    expect(validateRelativePath('.git/config')).toBeNull();
    expect(touchesGitMetadata('src/.git/x')).toBe(true);
  });
});

describe('webview message schema (AC-14)', () => {
  it('accepts the closed set and rejects everything else', () => {
    expect(validatePanelMessage({ type: 'startServer', variantId: 'v1ab' })).toEqual({ type: 'startServer', variantId: 'v1ab' });
    expect(validatePanelMessage({ type: 'setRoute', route: 'dashboard' })).toEqual({ type: 'setRoute', route: '/dashboard' });
    expect(validatePanelMessage({ type: 'setRoute', route: 'https://evil.example/x' })).toBeNull();
    expect(validatePanelMessage({ type: 'exec', command: 'rm -rf /' })).toBeNull();
    expect(validatePanelMessage({ type: 'startServer', variantId: '../x' })).toBeNull();
    expect(validatePanelMessage(null)).toBeNull();
    expect(validatePanelMessage('startServer')).toBeNull();
  });
});

describe('port picking (AC-04)', () => {
  it('skips taken and busy ports, bounded by the range', async () => {
    const free = async (p: number) => p !== 4301;
    expect(await pickPort(4300, 4305, new Set([4300]), free)).toBe(4302);
    expect(await pickPort(4300, 4300, new Set([4300]), free)).toBeNull();
  });
});
