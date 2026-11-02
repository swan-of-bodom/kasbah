/** Seconds since `start`, a `performance.now()` reading. */
export const secondsSince = (start: number): number => (performance.now() - start) / 1000;

/** How long work that never awaits I/O runs before it lets the event loop serve the rest (API, reads, timers). */
export const YIELD_MS = 25;

/** Resumes after the event loop has run what was waiting. */
export const yieldToEventLoop = (): Promise<void> => new Promise((done) => setImmediate(done));
