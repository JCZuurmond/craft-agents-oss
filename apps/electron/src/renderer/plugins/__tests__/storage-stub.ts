/**
 * In-memory Storage stubs for bun tests. Imported BEFORE the panel store so
 * its module-level state initialization sees them (ES module evaluation
 * order follows import order).
 */

function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

const g = globalThis as Record<string, unknown>
if (!g.localStorage) g.localStorage = createMemoryStorage()
if (!g.window) g.window = globalThis
const w = g.window as Record<string, unknown>
if (!w.sessionStorage) w.sessionStorage = createMemoryStorage()
