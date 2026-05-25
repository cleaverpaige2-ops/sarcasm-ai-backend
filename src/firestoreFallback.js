// src/firestoreFallback.js
// Lightweight in-memory fallback for "db" during local dev/testing.
// Not for production.

export function createFirestoreFallback() {
  const store = new Map(); // map of collection -> map(docId -> object)

  function collection(name) {
    if (!store.has(name)) store.set(name, new Map());
    const col = store.get(name);

    function doc(id) {
      return {
        id,
        async get() {
          const docData = col.get(id);
          return {
            exists: docData !== undefined,
            data() { return docData ?? {}; },
          };
        },
        async set(data, opts = {}) {
          const current = col.get(id) || {};
          if (opts && opts.merge) {
            col.set(id, { ...current, ...data });
          } else {
            col.set(id, data);
          }
          return true;
        },
      };
    }

    return { doc, _colMap: col };
  }

  // runTransaction provides tx-like API: tx.get(docRef), tx.set(docRef, data, {merge})
  async function runTransaction(worker) {
    // simple transaction: provide get & set operating directly on in-memory map
    const tx = {
      async get(ref) {
        // ref is docRef object created above
        const docData = ref && ref.id && ref._colMap ? ref._colMap.get(ref.id) : undefined;
        return {
          exists: docData !== undefined,
          data() { return docData ?? {}; },
        };
      },
      async set(ref, data, opts) {
        // find collection map from ref
        if (!ref || !ref.id) throw new Error('Invalid doc ref for tx.set');
        // attempt to find the collection map by searching store (docRef objects had closure access)
        // Simpler: we expect caller to pass the docRef from collection(...).doc(id) created above.
        // That docRef.set exists; but to allow reuse we implement a simple fallback
        if (typeof ref.set === 'function') {
          return ref.set(data, opts);
        }
        // otherwise set by directly accessing store maps (shouldn't reach here)
        throw new Error('tx.set: unsupported ref shape');
      },
    };

    return worker(tx);
  }

  return {
    collection,
    runTransaction,
  };
}