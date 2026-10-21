/** Seconds since `start`, a `performance.now()` reading. */
export const secondsSince = (start: number): number => (performance.now() - start) / 1000;
