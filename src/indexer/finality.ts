import type { RpcClient } from "../rpc/client.ts";

/** How often the newest L1-accepted block is read again: L1 accepts Starknet blocks in batches, hours apart. */
const L1_REFRESH_MS = 30_000;

/**
 * The newest block that can't be reorged, as of a head: `reorgWindow` blocks below it, or with `finality: "l1"` the
 * newest block Ethereum accepted (`l1_accepted`).
 */
export class Finality {
  readonly #rpc: RpcClient;
  readonly #window: number | undefined;
  #l1: { block: number; at: number } | undefined;

  /** `window` undefined: L1 finality. */
  constructor(rpc: RpcClient, window: number | undefined) {
    this.#rpc = rpc;
    this.#window = window;
  }

  /** What decides finality, for messages. */
  get rule(): string {
    return this.#window === undefined ? "accepted on L1" : `${this.#window} blocks below the head`;
  }

  async finalAt(head: number): Promise<number> {
    if (this.#window !== undefined) return head - this.#window;
    if (this.#l1 === undefined || performance.now() - this.#l1.at > L1_REFRESH_MS) {
      const b = await this.#rpc.request<{ block_number: number }>("starknet_getBlockWithTxHashes", {
        block_id: "l1_accepted",
      });
      this.#l1 = { block: b.block_number, at: performance.now() };
    }
    return Math.min(head, this.#l1.block);
  }
}
