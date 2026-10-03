/** Binary min-heap of (key, id) pairs on typed arrays; stale entries are skipped by the caller. */
export class MinHeap {
  private keys: Float64Array;
  private ids: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.ids = new Int32Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  push(key: number, id: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      const ids = new Int32Array(this.size * 2);
      keys.set(this.keys);
      ids.set(this.ids);
      this.keys = keys;
      this.ids = ids;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.ids[i] = this.ids[p];
      i = p;
    }
    this.keys[i] = key;
    this.ids[i] = id;
  }

  /** Smallest key. Only meaningful while size > 0. */
  peekKey(): number {
    return this.keys[0];
  }

  pop(): number {
    const top = this.ids[0];
    const key = this.keys[--this.size];
    const id = this.ids[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.keys[i] = this.keys[c];
      this.ids[i] = this.ids[c];
      i = c;
    }
    this.keys[i] = key;
    this.ids[i] = id;
    return top;
  }
}
