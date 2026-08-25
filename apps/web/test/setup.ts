/* 发件箱住在 localStorage 里，而 vitest 默认跑在 node 环境（没有它）。
 *
 *  这里给一个**最小的内存替身**，不引 jsdom：被测的是队列逻辑，
 *  不是浏览器。引一整个 DOM 只为一个 Storage，既慢又会把
 *  "这组测试到底在测什么"搅浑。 */
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(), writable: true, configurable: true
});
