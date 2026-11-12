// Failure-based cooldown for public Piped/Invidious hosts.
// Keeps dead instances out of the request path without actively probing them.

export function createInstanceHealth({
  cooldownMs = 2 * 60 * 1000,
  failureThreshold = 2,
  maxEntries = 100,
  now = Date.now
} = {}) {
  const entries = new Map();

  function keyFor(base) {
    try {
      return new URL(base).hostname;
    } catch (e) {
      return String(base);
    }
  }

  function available(instances) {
    const currentTime = now();
    const healthy = instances.filter((base) => {
      const entry = entries.get(keyFor(base));
      return !entry?.cooldownUntil || entry.cooldownUntil <= currentTime;
    });
    if (healthy.length) return healthy;

    // Everything is cooling down: probe only the host closest to recovery so we
    // notice it coming back without retrying every dead host.
    let soonest = null;
    let soonestAt = Infinity;
    for (const base of instances) {
      const entry = entries.get(keyFor(base));
      if (entry?.cooldownUntil && entry.cooldownUntil < soonestAt) {
        soonestAt = entry.cooldownUntil;
        soonest = base;
      }
    }
    return soonest ? [soonest] : instances.slice();
  }

  function recordFailure(base) {
    const key = keyFor(base);
    const entry = entries.get(key) || { failures: 0, cooldownUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= failureThreshold) {
      entry.cooldownUntil = now() + cooldownMs;
      entry.failures = 0;
    }
    if (!entries.has(key) && entries.size >= maxEntries) {
      entries.delete(entries.keys().next().value);
    }
    entries.set(key, entry);
  }

  function recordSuccess(base) {
    entries.delete(keyFor(base));
  }

  function reset() {
    entries.clear();
  }

  return { available, recordFailure, recordSuccess, reset, keyFor };
}
