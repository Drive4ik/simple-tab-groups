// one instance per query: records at its own evaluation whether the global is there already
const query = new URL(import.meta.url).search.slice(1);

(self.orderProbes ??= []).push({query, seen: Symbol.for('__order_global__') in self});
