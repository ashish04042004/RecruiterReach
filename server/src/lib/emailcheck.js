import dns from 'node:dns/promises';

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms)),
  ]);
}

const cache = new Map();

/** Returns 'valid' when the domain can receive mail, 'no_mx' when it clearly cannot, 'unchecked' when DNS was inconclusive. */
export async function checkDomain(domain) {
  if (cache.has(domain)) return cache.get(domain);
  let result = 'unchecked';
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 8000);
    result = mx?.length ? 'valid' : 'no_mx';
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      try {
        const a = await withTimeout(dns.resolve4(domain), 5000);
        result = a?.length ? 'valid' : 'no_mx';
      } catch (inner) {
        result = inner.code === 'ETIMEOUT' ? 'unchecked' : 'no_mx';
      }
    }
  }
  cache.set(domain, result);
  return result;
}
