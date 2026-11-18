function checkLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("Concurrency must be between 1 and 16.");
}

// Stable output order, bounded workers, and no new work after a failure.
// Wait for in-flight workers before returning so publication/locks cannot race them.
export async function mapConcurrent(items, limit, mapper) {
  checkLimit(limit);
  const results = new Array(items.length);
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}

export function createRequestLimiter(limit) {
  checkLimit(limit);
  let active = 0, failure;
  const queue = [];
  function pump() {
    while (!failure && active < limit && queue.length) {
      const { work, resolve, reject } = queue.shift(); active++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; pump(); });
    }
  }
  return {
    run(work) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => { queue.push({ work, resolve, reject }); pump(); });
    },
    stop(error) { failure ??= error; for (const entry of queue.splice(0)) entry.reject(failure); },
  };
}
