import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { parseUsageCache, usageConfigPath } from '../src/usage.ts';

describe('usageConfigPath', () => {
  test('reads the cache of the account home CLAUDE_CONFIG_DIR names', () => {
    expect(usageConfigPath({ CLAUDE_CONFIG_DIR: '/estate/.shop/homes/claude/secondary' }, '/home/me'))
      .toBe(path.join('/estate/.shop/homes/claude/secondary', '.claude.json'));
  });

  test('falls back to the global config file without one', () => {
    expect(usageConfigPath({}, '/home/me')).toBe(path.join('/home/me', '.claude.json'));
    expect(usageConfigPath({ CLAUDE_CONFIG_DIR: '' }, '/home/me')).toBe(path.join('/home/me', '.claude.json'));
  });
});

describe('parseUsageCache', () => {
  test('orders windows most-constrained first and skips non-window entries', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const windows = parseUsageCache({
      utilization: {
        five_hour: { utilization: 12, resets_at: '2026-11-24T15:00:00Z' },
        seven_day: { utilization: 64, resets_at: '2026-11-28T00:00:00Z' },
        spend: 3,
        extra_usage: { utilization: 99, resets_at: '2026-11-30T00:00:00Z' },
      },
    }, now);
    expect(windows.map(w => w.name)).toEqual([ 'seven_day', 'five_hour' ]);
  });
});
