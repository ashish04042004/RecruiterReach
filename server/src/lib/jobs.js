const jobs = new Map();
let nextId = 1;

/**
 * Runs `work(job)` in the background and exposes progress for polling.
 * `work` should update job.done / job.failed / job.errors as it goes.
 */
export function startJob(type, total, work) {
  const job = {
    id: nextId++,
    type,
    status: 'running',
    total,
    done: 0,
    failed: 0,
    errors: [],
    result: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  Promise.resolve()
    .then(() => work(job))
    .then((result) => {
      job.result = result ?? job.result;
      job.status = 'completed';
    })
    .catch((err) => {
      job.status = 'error';
      job.errors.push(err.message || String(err));
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

/** Process items with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
