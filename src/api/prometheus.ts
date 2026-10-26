export type Sample = [labels: Record<string, string>, value: number];
export type Metric = { name: string; help: string; type: "counter" | "gauge"; samples: Sample[] };

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
