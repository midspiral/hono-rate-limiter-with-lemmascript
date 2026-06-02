// ── UNTRUSTED glue: the per-key admission-log store ──────────────────────────
// The verified core (core.verified.ts) is a pure function over a single key's
// log. This store is the mutable, I/O-shaped part the proof does NOT cover: it
// maps a client key to its log and performs the read-modify-write. The proof
// holds PER KEY provided this read-modify-write is atomic for that key (a single
// Node process and a Map gives that for free; a shared Redis store needs a Lua
// script / compare-and-set — see README "What's verified, what's trusted").

export interface LogStore {
  get(key: string): number[];
  set(key: string, log: number[]): void;
}

// The default in-process store: a Map of key → admission log. Logs are already
// pruned to <= limit entries by the verified core, so memory stays bounded by
// (active keys × limit). Keys idle longer than a window are swept lazily on read.
export class MemoryStore implements LogStore {
  private readonly logs = new Map<string, number[]>();

  get(key: string): number[] {
    return this.logs.get(key) ?? [];
  }

  set(key: string, log: number[]): void {
    if (log.length === 0) {
      this.logs.delete(key); // nothing in-window ⇒ drop the key, keep the map small
    } else {
      this.logs.set(key, log);
    }
  }
}
