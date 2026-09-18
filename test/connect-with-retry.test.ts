import { describe, test, expect } from 'bun:test';

// BLO-21615: this block used to live in minions.test.ts, whose file-level
// beforeAll/beforeEach require a live Postgres — so these pure fakeEngine unit
// tests were gated behind a database they never touch, and could not be run
// while iterating on the retry logic itself. Moved out verbatim, plus the new
// wall-clock-budget cases.

// --- v0.21: connectWithRetry + isRetryableDbConnectError ---

describe('connectWithRetry / isRetryableDbConnectError', () => {
  test('isRetryableDbConnectError matches transient patterns', async () => {
    const { isRetryableDbConnectError } = await import('../src/core/db.ts');
    expect(isRetryableDbConnectError(new Error('password authentication failed for user postgres'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('connection refused'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('the database system is starting up'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('something happened: ECONNRESET'))).toBe(true);
  });

  // BLO-21615: db.ts kept its own inline pattern list that lacked ECONNREFUSED,
  // so connectWithRetry rethrew on attempt 1 and `serve --http` exited 1 every
  // time it started during a DB-pod restart. Now delegates to retry-matcher.
  test('isRetryableDbConnectError matches ECONNREFUSED (BLO-21615)', async () => {
    const { isRetryableDbConnectError } = await import('../src/core/db.ts');
    expect(isRetryableDbConnectError(new Error('connect ECONNREFUSED 10.99.216.174:5432'))).toBe(true);
  });

  test('connectWithRetry survives an ECONNREFUSED window (BLO-21615)', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        // Two refusals — a DB pod restart leaving the Service with zero ready
        // endpoints — then the endpoint comes back.
        if (attempts <= 2) {
          throw new Error(
            'Cannot connect to database: connect ECONNREFUSED 10.99.216.174:5432. ' +
            'Fix: Check your connection URL in ~/.gbrain/config.json',
          );
        }
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    await connectWithRetry(fakeEngine, { database_url: 'postgres://x' },
      { baseDelayMs: 1, maxElapsedMs: 5_000, log: () => {} });
    expect(attempts).toBe(3);
  });

  // BLO-21615 round 2 / Ally's Important finding on #12: the budget was three
  // ATTEMPTS (1s + 2s), so a refusal window longer than ~3s still exited 1 —
  // and a real Postgres restart is tens of seconds. Budget is now wall-clock.
  // This is the "refusal outlasts the three-attempt boundary" case Ally asked
  // for: 8 consecutive refusals, i.e. well past where the old code gave up.
  test('connectWithRetry outlasts the old 3-attempt boundary (BLO-21615)', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        if (attempts <= 8) throw new Error('connect ECONNREFUSED 10.0.0.1:5432');
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    await connectWithRetry(fakeEngine, { database_url: 'postgres://x' },
      { baseDelayMs: 1, maxDelayMs: 2, maxElapsedMs: 5_000, log: () => {} });
    expect(attempts).toBe(9);
  });

  test('isRetryableDbConnectError rejects permanent errors', async () => {
    const { isRetryableDbConnectError } = await import('../src/core/db.ts');
    expect(isRetryableDbConnectError(new Error('extension "vector" does not exist'))).toBe(false);
    expect(isRetryableDbConnectError(new Error('relation "pages" does not exist'))).toBe(false);
    expect(isRetryableDbConnectError(new Error('syntax error at end of input'))).toBe(false);
  });

  test('connectWithRetry: 1st rejects transient, 2nd succeeds', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        if (attempts === 1) throw new Error('password authentication failed for user postgres');
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    await connectWithRetry(fakeEngine, { database_url: 'postgres://x' },
      { baseDelayMs: 1, maxElapsedMs: 5_000, log: () => {} });
    expect(attempts).toBe(2);
  });

  // BLO-21615 round 2: this used to assert `attempts === 3`, encoding the old
  // fixed-attempt budget. The budget is wall-clock now, so the contract it
  // should pin is "gives up when the budget is spent, having actually retried"
  // — an attempt count is an implementation detail of the backoff schedule.
  test('connectWithRetry: transient rejects → throws once the budget is spent', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        throw new Error('connection refused');
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    const started = Date.now();
    await expect(
      connectWithRetry(fakeEngine, { database_url: 'postgres://x' },
        { baseDelayMs: 5, maxDelayMs: 5, maxElapsedMs: 60, log: () => {} })
    ).rejects.toThrow('connection refused');
    expect(attempts).toBeGreaterThan(1);          // it retried...
    expect(Date.now() - started).toBeLessThan(2_000); // ...and still terminated.
  });

  // BLO-21615 round 2 / Ally's Important finding on #13: the give-up test was
  // `Date.now() + delay >= deadline`, which ABANDONS the unspent remainder
  // rather than clamping the last sleep to it. Walking the shipped defaults
  // (1s base, 15s ceiling, 30s budget) it quit at t≈15s — half the advertised
  // patience, and inside the window a Postgres restart occupies.
  //
  // Scaled 100×: 10ms base, 150ms ceiling, 300ms budget. Failures land at
  // t≈0/10/30/70/150; at t≈150 the next delay is the 150ms ceiling, so the old
  // code gave up there. Clamped, it sleeps the remaining 150ms and gives up at
  // t≈300. Asserting elapsed ≥ 250ms is what distinguishes the two.
  test('connectWithRetry: spends the WHOLE budget, not half of it (BLO-21615)', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    const fakeEngine = {
      connect: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:5432'); },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    const started = Date.now();
    await expect(
      connectWithRetry(fakeEngine, { database_url: 'postgres://x' },
        { baseDelayMs: 10, maxDelayMs: 150, maxElapsedMs: 300, log: () => {} })
    ).rejects.toThrow('ECONNREFUSED');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);  // used the budget...
    expect(elapsed).toBeLessThan(1_500);          // ...and did not overshoot it.
  });

  test('connectWithRetry: permanent error does NOT retry', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        throw new Error('extension "vector" does not exist');
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    await expect(
      connectWithRetry(fakeEngine, { database_url: 'postgres://x' }, { baseDelayMs: 1, log: () => {} })
    ).rejects.toThrow('extension "vector"');
    expect(attempts).toBe(1);
  });

  test('connectWithRetry: noRetry honored', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        throw new Error('connection refused');
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    await expect(
      connectWithRetry(fakeEngine, { database_url: 'postgres://x' }, { noRetry: true, log: () => {} })
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});
