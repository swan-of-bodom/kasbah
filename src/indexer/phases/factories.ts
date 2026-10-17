import { type Child, children } from "../events.ts";
import type { Run } from "../open.ts";

/** Every child created up to the backfill's end, before any child event is fetched: one commit. */
export async function factories(run: Run): Promise<void> {
  const { factories, status, signal, cache, sources, plan, position } = run;
  const from = position.watermark + 1;
  const to = plan.backfillTo;
  if (factories.length === 0 || from > to) return;
  const started = performance.now();
  status.enter("factories");
  status.setRange(from, to, from - 1);
  const found = new Map<string, Child>();
  let through = from - 1;
  for await (const batch of children(run, from, to, true)) {
    for (const c of batch.children) if (!found.has(c.address)) found.set(c.address, c);
    through = batch.through;
    status.range.through = through;
    if (signal.aborted) break;
  }
  const resolved = await Promise.all([...found.values()].map((c) => sources.resolve(c.contract, c.address, c.block, plan.classTo, true)));
  const watched = resolved.filter((w) => w !== undefined);
  await position.commit({ kind: "children", through, children: watched });
  cache?.untrack();
  status.note({ kind: "factories", children: watched.length, through, seconds: (performance.now() - started) / 1000 });
}
