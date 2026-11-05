export type Sample = [labels: Record<string, string>, value: number];
export type Metric = { name: string; help: string; type: "counter" | "gauge"; samples: Sample[] };

/** A metric with one sample and no labels. */
export const one = (name: string, type: Metric["type"], help: string, value: number): Metric => ({
  name,
  type,
  help,
  samples: [[{}, value]],
});

/** The phase running and the last block committed: what `/metrics` says with or without the indexer. */
export const progress = (phase: string, checkpoint: number): Metric[] => [
  { name: "phase", type: "gauge", help: "The phase running (1).", samples: [[{ phase }, 1]] },
  one("checkpoint", "gauge", "Last block committed.", checkpoint),
];

const quoted = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Metrics in Prometheus' text format, `kasbah_` first. */
export function prometheus(metrics: Metric[]): string {
  const lines: string[] = [];
  for (const m of metrics) {
    const name = `kasbah_${m.name}`;
    lines.push(`# HELP ${name} ${m.help}`, `# TYPE ${name} ${m.type}`);
    for (const [labels, value] of m.samples) {
      const l = Object.entries(labels).map(([k, v]) => `${k}="${quoted(v)}"`);
      lines.push(`${name}${l.length > 0 ? `{${l.join(",")}}` : ""} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
