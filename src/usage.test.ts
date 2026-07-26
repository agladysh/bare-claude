import { describe, expect, test } from 'bun:test';

import { isBurningFast, parseUsageCache, parseUsageWindow } from './usage.ts';

const hour = 60 * 60 * 1000;
const now = Date.parse('2026-07-26T12:00:00.000Z');

describe('parseUsageWindow', () => {
  test('derives elapsed fraction and time to reset', () => {
    // Halfway through a five hour window: it resets in 2.5 hours.
    const window = parseUsageWindow(
      'five_hour',
      { utilization: 40, resets_at: new Date(now + 2.5 * hour).toISOString() },
      now
    );

    expect(window).not.toBeNull();
    expect(window?.elapsed).toBeCloseTo(0.5, 5);
    expect(window?.secondsUntilReset).toBe(9000);
    expect(window?.burningFast).toBe(false);
  });

  test('clamps elapsed to the unit interval for an overdue reset', () => {
    const window = parseUsageWindow(
      'five_hour',
      { utilization: 100, resets_at: new Date(now - hour).toISOString() },
      now
    );

    expect(window?.elapsed).toBe(1);
    expect(window?.secondsUntilReset).toBe(0);
  });

  test('leaves elapsed unknown for a window of unknown length', () => {
    const window = parseUsageWindow(
      'Fable',
      { utilization: 88, resets_at: new Date(now + hour).toISOString() },
      now
    );

    expect(window?.elapsed).toBeNull();
    expect(window?.burningFast).toBeNull();
  });

  test('rejects windows the server left unpopulated', () => {
    expect(parseUsageWindow('seven_day', null, now)).toBeNull();
    expect(parseUsageWindow('seven_day', { utilization: null, resets_at: null }, now)).toBeNull();
    expect(parseUsageWindow('seven_day', { utilization: 10 }, now)).toBeNull();
    expect(parseUsageWindow('seven_day', { utilization: 10, resets_at: 'nonsense' }, now)).toBeNull();
  });
});

describe('isBurningFast', () => {
  test('flags a five hour window spent early', () => {
    expect(isBurningFast('five_hour', 95, 0.5)).toBe(true);
    expect(isBurningFast('five_hour', 95, 0.9)).toBe(false);
    expect(isBurningFast('five_hour', 80, 0.1)).toBe(false);
  });

  test('applies each seven day threshold', () => {
    expect(isBurningFast('seven_day', 30, 0.1)).toBe(true);
    expect(isBurningFast('seven_day', 30, 0.2)).toBe(false);
    expect(isBurningFast('seven_day', 80, 0.5)).toBe(true);
  });

  test('never flags a window it has no thresholds for', () => {
    expect(isBurningFast('Fable', 99, 0.01)).toBe(false);
  });
});

describe('parseUsageCache', () => {
  const cache = {
    fetchedAtMs: now,
    utilization: {
      five_hour: { utilization: 73, resets_at: new Date(now + hour).toISOString() },
      seven_day: { utilization: 60, resets_at: new Date(now + 5 * 24 * hour).toISOString() },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
      spend: { percent: 0 },
      limits: [
        { kind: 'session', percent: 73, resets_at: new Date(now + hour).toISOString() },
        {
          kind: 'weekly_scoped',
          percent: 88,
          resets_at: new Date(now + 5 * 24 * hour).toISOString(),
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    },
  };

  test('reports every populated window, most constrained first', () => {
    const windows = parseUsageCache(cache, now);

    expect(windows.map(w => w.name)).toEqual([ 'Fable', 'five_hour', 'seven_day' ]);
    expect(windows.map(w => w.utilization)).toEqual([ 88, 73, 60 ]);
  });

  test('skips bookkeeping keys and unpopulated windows', () => {
    const names = parseUsageCache(cache, now).map(w => w.name);

    expect(names).not.toContain('extra_usage');
    expect(names).not.toContain('spend');
    expect(names).not.toContain('limits');
    expect(names).not.toContain('seven_day_opus');
  });

  test('takes model scoped weeklies only from limits', () => {
    const fable = parseUsageCache(cache, now).find(w => w.name === 'Fable');

    expect(fable?.utilization).toBe(88);
    expect(fable?.elapsed).toBeNull();
  });

  test('returns nothing for a shape it does not recognize', () => {
    expect(parseUsageCache(null, now)).toEqual([]);
    expect(parseUsageCache({}, now)).toEqual([]);
    expect(parseUsageCache({ utilization: 'nope' }, now)).toEqual([]);
  });
});
