/**
 * Track recently used dynamic (MCP) tools for post-compaction hot-reload.
 *
 * Full compaction clears loaded dynamic tool schemas from history. Keeping a
 * short LRU of tools the model actually called lets us re-load their schemas
 * after compact without forcing a full cold re-discovery round-trip.
 */

export const DEFAULT_RECENT_DYNAMIC_TOOLS_LIMIT = 12;

export class RecentDynamicToolTracker {
  private readonly order: string[] = [];
  private readonly names = new Set<string>();

  constructor(private readonly limit: number = DEFAULT_RECENT_DYNAMIC_TOOLS_LIMIT) {}

  record(name: string): void {
    if (name.length === 0) return;
    if (this.names.has(name)) {
      const index = this.order.indexOf(name);
      if (index >= 0) this.order.splice(index, 1);
    } else {
      this.names.add(name);
    }
    this.order.push(name);
    while (this.order.length > this.limit) {
      const dropped = this.order.shift();
      if (dropped !== undefined) this.names.delete(dropped);
    }
  }

  /** Most-recent last; returned as a copy in LRU order (oldest first). */
  list(): readonly string[] {
    return [...this.order];
  }

  /** Newest-first names, capped. */
  recent(max: number = this.limit): readonly string[] {
    if (max <= 0) return [];
    return this.order.slice(-max).reverse();
  }

  clear(): void {
    this.order.length = 0;
    this.names.clear();
  }
}
