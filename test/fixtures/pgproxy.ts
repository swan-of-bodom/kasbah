import { connect, createServer, type Socket } from "node:net";

/**
 * Where `cutCommit` drops a connection: before Postgres sees the COMMIT, or after it ran it, before its answer. `half-open`
 * drops only the client's side before the COMMIT, as a network drop that never reaches the server: Postgres keeps
 * the transaction open.
 */
export type CommitCut = "before" | "after" | "half-open";

/** The startup message's code when the client first asks for TLS: Postgres answers one byte, then the real startup. */
const SSL_REQUEST = 80877103;

/**
 * A TCP proxy in front of Postgres that loses connections the way a restart or a bad network does: `cut()` drops
 * every open one, `down(ms)` also drops new ones for a while, `cutCommit(when)` drops the next COMMIT's connection.
 * It reads the client's side of the wire protocol only to find COMMITs (sent as simple queries).
 */
export async function pgProxy(database: string) {
  const target = new URL(database);
  const open = new Set<() => void>();
  const halfOpen = new Set<Socket>();
  let downUntil = 0;
  let commitCut: CommitCut | undefined;
  const counts = { connections: 0, refused: 0, cuts: 0, commits: 0 };

  const server = createServer((client: Socket) => {
    if (Date.now() < downUntil) {
      counts.refused++;
      return void client.destroy();
    }
    counts.connections++;
    const upstream = connect(Number(target.port || 5432), target.hostname);
    const drop = () => {
      client.destroy();
      if (!halfOpen.has(upstream)) upstream.destroy();
      open.delete(drop);
    };
    open.add(drop);
    for (const s of [client, upstream]) {
      s.on("error", drop);
      s.on("close", drop);
    }
    let pending = Buffer.alloc(0);
    let started = false;
    let answerCut = false;
    client.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        // Before startup, messages have no type byte: just a length that counts itself.
        const head = started ? 5 : 4;
        if (pending.length < head) return;
        const length = started ? pending.readInt32BE(1) + 1 : pending.readInt32BE(0);
        if (pending.length < length) return;
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (!started) {
          started = message.readInt32BE(4) !== SSL_REQUEST;
          upstream.write(message);
          continue;
        }
        if (
          message[0] === 0x51 &&
          /^\s*COMMIT\b/i.test(message.subarray(5, length - 1).toString())
        ) {
          counts.commits++;
          if (commitCut === "half-open") {
            commitCut = undefined;
            counts.cuts++;
            halfOpen.add(upstream);
            return drop();
          }
          if (commitCut === "before") {
            commitCut = undefined;
            counts.cuts++;
            return drop();
          }
          if (commitCut === "after") {
            commitCut = undefined;
            answerCut = true;
          }
        }
        upstream.write(message);
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      // The client sends one query at a time, so the first bytes after the COMMIT are its answer.
      if (answerCut) {
        counts.cuts++;
        return drop();
      }
      client.write(chunk);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const url = new URL(database);
  url.hostname = "127.0.0.1";
  url.port = String(port);

  const cut = () => {
    for (const drop of [...open]) {
      counts.cuts++;
      drop();
    }
  };
  return {
    url: url.toString(),
    counts,
    cut,
    /** Drops every connection, and every new one for `ms`. */
    down(ms: number) {
      downUntil = Date.now() + ms;
      cut();
    },
    cutCommit(when: CommitCut) {
      commitCut = when;
    },
    close: () =>
      new Promise<void>((r) => {
        cut();
        for (const s of halfOpen) s.destroy();
        server.close(() => r());
      }),
  };
}
