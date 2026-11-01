// End-to-end A/B benchmark: an app in test/bench/apps run to `--to` on two builds of kasbah, alternating A, B, A, B.
//   pnpm bench:app                                   HEAD against the working tree, 5 pairs, cached, to block 700k
//   pnpm bench:app --a 0849af9 --b HEAD --cache off --heap 512 --pairs 3
//   pnpm bench:app --rpc sim --latency 120          fetch from a simulated node (test/bench/node.ts), not the RPC
// Each side is packed (`.` is the working tree, anything else a git rev) and installed into a copy of the app, so
// both run the same handlers. Results go to test/bench/results.
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";

const { values: a } = parseArgs({
  options: {
    app: { type: "string", default: "ekubo" },
    a: { type: "string", default: "HEAD" },
    b: { type: "string", default: "." },
    pairs: { type: "string", default: "5" },
    to: { type: "string", default: "700000" },
    heap: { type: "string", default: "4096" },
    cache: { type: "string", default: "on" },
    port: { type: "string", default: "42169" },
    timeout: { type: "string", default: "3600" },
    rpc: { type: "string", default: "real" },
    latency: { type: "string", default: "120" },
  },
});
if (a.rpc === "sim") a.cache = "off";

const repo = resolve(import.meta.dirname, "..");
const appDir = join(repo, "test/bench/apps", a.app);
const work = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "kasbah-bench", "work");
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const results = join(repo, "test/bench/results", `${stamp}-${a.app}`);

type Run = {
  side: "A" | "B";
  pair: number;
  seconds: number;
  maxRssMb: number;
  gaps: number;
  gapsOver400: number;
  gapSeconds: number;
  maxGapMs: number;
  cpuSeconds: number;
  rpcMedianMs: number;
};

/** Pairs whose RPC answered this much slower or faster on one side are left out of the comparison. */
const RPC_DRIFT = 0.25;

const sh = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

function turboOff(): boolean {
  const intel = "/sys/devices/system/cpu/intel_pstate/no_turbo";
  if (existsSync(intel)) return readFileSync(intel, "utf8").trim() === "1";
  const boost = "/sys/devices/system/cpu/cpufreq/boost";
  return existsSync(boost) && readFileSync(boost, "utf8").trim() === "0";
}

async function preflight() {
  if (!existsSync(appDir)) throw new Error(`no app at test/bench/apps/${a.app}`);
  if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is not set (.env)");
  if (a.cache === "off" && process.env.KASBAH_RPC_URL === undefined)
    throw new Error("KASBAH_RPC_URL is not set (.env)");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`Postgres is not reachable: ${(e as Error).message}`);
  }
  const cached = await client.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name LIKE 'kasbah_cache_%'`,
  );
  await client.end();
  if (a.cache === "on" && cached.rowCount === 0)
    console.warn("no kasbah_cache_* schema: the first run will fetch");
  if (turboOff())
    throw new Error("CPU turbo is off (a firmware glitch makes runs ~2x slower): reboot first");
  if (loadavg()[0]! > 2)
    console.warn(`load average ${loadavg()[0]!.toFixed(1)}: close other work for clean numbers`);
}

/** Packs `rev` and installs it into a fresh copy of the app. */
function build(side: "A" | "B", rev: string): string {
  const dir = join(work, side);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let src = repo;
  if (rev !== ".") {
    src = join(dir, "src");
    mkdirSync(src);
    execFileSync("sh", ["-c", `git -C "${repo}" archive "${rev}" | tar -x -C "${src}"`]);
    execFileSync("ln", ["-s", join(repo, "node_modules"), join(src, "node_modules")]);
  }
  sh("pnpm", ["pack", "--pack-destination", dir], src);
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
  execFileSync("mv", [join(dir, tgz), join(dir, "kasbah.tgz")]);
  cpSync(appDir, join(dir, "app"), { recursive: true, filter: (f) => !f.includes("node_modules") });
  sh("pnpm", ["install", "--force", "--silent"], join(dir, "app"));
  const sha = rev === "." ? "working tree" : sh("git", ["rev-parse", "--short", rev], repo).trim();
  console.log(`${side} = ${rev} (${sha})`);
  return join(dir, "app");
}

const simPort = Number(a.port) + 1;
let turboWentOff = false;

/** Starts test/bench/node.ts, one for all runs, and resolves once it listens. */
function simulatedNode(): Promise<ReturnType<typeof spawn>> {
  const node = spawn(
    process.execPath,
    [
      "--no-warnings",
      join(repo, "test/bench/node.ts"),
      "--port",
      String(simPort),
      "--latency",
      a.latency,
    ],
    { stdio: ["ignore", "pipe", "inherit"], env: process.env },
  );
  console.log(`simulated node on :${simPort}, ${a.latency} ms per call`);
  return new Promise((ready, fail) => {
    node.on("exit", (code) => fail(new Error(`the simulated node exited (${code})`)));
    node.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("ready")) ready(node);
    });
  });
}

function once(side: "A" | "B", pair: number, cwd: string): Promise<Run | undefined> {
  if (turboOff()) throw new Error("CPU turbo went off during the runs: reboot and run again");
  const log = join(results, `${side}-${pair}.log`);
  const out = join(results, `${side}-${pair}.json`);
  const node = [
    `--max-old-space-size=${a.heap}`,
    "--import",
    join(repo, "test/bench/probe.ts"),
    "node_modules/kasbah/dist/cli/main.js",
    "start",
    "--schema",
    "bench_run",
    "--to",
    a.to,
    "--reset",
    "--no-ui",
  ];
  const awake = (() => {
    try {
      execFileSync("which", ["systemd-inhibit"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const [cmd, args] = awake
    ? [
        "systemd-inhibit",
        ["--what=sleep:idle", "--who=kasbah-bench", "--why=benchmark", process.execPath, ...node],
      ]
    : [process.execPath, node];
  const fd = openSync(log, "w");
  const child = spawn(cmd, args as string[], {
    cwd,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      ...(a.rpc === "sim" ? { KASBAH_RPC_URL: `http://127.0.0.1:${simPort}` } : {}),
      PORT: a.port,
      KASBAH_BENCH_OUT: out,
      KASBAH_BENCH_CACHE: a.cache,
    },
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), Number(a.timeout) * 1000);
  // The firmware can turn turbo off mid-run, which slows everything ~2x: such a run says nothing.
  let slowed = false;
  const watch = setInterval(() => {
    if (turboOff()) slowed = true;
  }, 2_000);
  return new Promise((done) =>
    child.on("exit", (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      if (slowed) {
        console.log(`pair ${pair} ${side}: discarded, CPU turbo went off during the run`);
        turboWentOff = true;
        return done(undefined);
      }
      const seconds = readFileSync(log, "utf8").match(/handled in ([\d.]+)s/)?.[1];
      if (code !== 0 || seconds === undefined || !existsSync(out)) {
        console.log(`pair ${pair} ${side}: failed (exit ${code}), see ${log}`);
        return done(undefined);
      }
      const r: Run = {
        side,
        pair,
        seconds: Number(seconds),
        ...JSON.parse(readFileSync(out, "utf8")),
      };
      console.log(
        `pair ${pair} ${side}: ${r.seconds.toFixed(1)} s, rss ${r.maxRssMb.toFixed(0)} MB, ` +
          `stops >100 ms ${r.gaps} (>400 ms ${r.gapsOver400}, ${r.gapSeconds.toFixed(1)} s), longest ${r.maxGapMs.toFixed(0)} ms, ` +
          `cpu ${r.cpuSeconds.toFixed(0)} s` +
          (r.rpcMedianMs > 0 ? `, rpc median ${r.rpcMedianMs.toFixed(0)} ms` : ""),
      );
      done(r);
    }),
  );
}

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

function summary(runs: Run[]): string {
  const lines: string[] = [];
  const side = (s: "A" | "B") => runs.filter((r) => r.side === s);
  for (const s of ["A", "B"] as const) {
    const rs = side(s);
    if (rs.length === 0) continue;
    const t = rs.map((r) => r.seconds);
    lines.push(
      `${s}: median ${median(t).toFixed(1)} s (min ${Math.min(...t).toFixed(1)}, max ${Math.max(...t).toFixed(1)}), ` +
        `rss ${median(rs.map((r) => r.maxRssMb)).toFixed(0)} MB, stops >400 ms ${median(rs.map((r) => r.gapsOver400))}, ` +
        `longest ${median(rs.map((r) => r.maxGapMs)).toFixed(0)} ms, cpu ${median(rs.map((r) => r.cpuSeconds)).toFixed(0)} s`,
    );
  }
  const pairs = side("A").flatMap((x) =>
    side("B")
      .filter((y) => y.pair === x.pair)
      .map((y) => [x, y] as const),
  );
  // Each pair ran minutes apart, so B/A within a pair cancels a slow hour of the RPC or the machine.
  const drifted = ([x, y]: (typeof pairs)[number]) =>
    x.rpcMedianMs > 0 && Math.abs(y.rpcMedianMs / x.rpcMedianMs - 1) > RPC_DRIFT;
  const steady = pairs.filter((p) => !drifted(p));
  const left = pairs.filter(drifted).map(([x]) => x.pair);
  if (left.length > 0)
    lines.push(
      `left out, the RPC's speed changed within the pair by over ${RPC_DRIFT * 100}%: pairs ${left.join(", ")}`,
    );
  if (steady.length > 0) {
    const pct = (f: (r: Run) => number) =>
      ((median(steady.map(([x, y]) => f(y) / f(x))) - 1) * 100).toFixed(1);
    const wins = steady.filter(([x, y]) => y.seconds < x.seconds).length;
    lines.push(
      `B vs A, median of the pairs' ratios: time ${pct((r) => r.seconds)}%, cpu ${pct((r) => r.cpuSeconds)}%, ` +
        `rss ${pct((r) => r.maxRssMb)}%; B faster in ${wins} of ${steady.length} pairs`,
    );
  }
  return lines.join("\n");
}

await preflight();
mkdirSync(results, { recursive: true });
console.log(
  `${a.app} to block ${a.to}, cache ${a.cache}, heap ${a.heap} MB, ${a.pairs} pairs; logs in ${results}`,
);
const dirs = { A: build("A", a.a), B: build("B", a.b) };
const sim = a.rpc === "sim" ? await simulatedNode() : undefined;
const runs: Run[] = [];
try {
  for (let pair = 1; pair <= Number(a.pairs); pair++)
    for (const side of ["A", "B"] as const) {
      const r = await once(side, pair, dirs[side]);
      if (turboWentOff) throw new Error("CPU turbo went off during a run: reboot and run again");
      if (r !== undefined) runs.push(r);
    }
} finally {
  sim?.kill("SIGTERM");
  const text = summary(runs);
  console.log(`\n${text}`);
  writeFileSync(join(results, "summary.json"), JSON.stringify({ options: a, runs }, null, 2));
  writeFileSync(join(results, "summary.txt"), `${JSON.stringify(a)}\n${text}\n`);
}
