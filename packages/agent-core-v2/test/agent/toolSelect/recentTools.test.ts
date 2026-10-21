import { describe, expect, it } from 'vitest';

import { RecentDynamicToolTracker } from '#/agent/toolSelect/recentTools';

describe('RecentDynamicToolTracker', () => {
  it('keeps newest tools and reorders on re-record', () => {
    const tracker = new RecentDynamicToolTracker(3);
    tracker.record('a');
    tracker.record('b');
    tracker.record('c');
    tracker.record('d');
    expect(tracker.list()).toEqual(['b', 'c', 'd']);
    tracker.record('b');
    expect(tracker.list()).toEqual(['c', 'd', 'b']);
    expect(tracker.recent(2)).toEqual(['b', 'd']);
  });

  it('clears all tracked names', () => {
    const tracker = new RecentDynamicToolTracker();
    tracker.record('mcp__x');
    tracker.clear();
    expect(tracker.list()).toEqual([]);
  });
});
