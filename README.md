# kasbah

A minimal, fast Starknet indexer in TypeScript. Design and decisions: [DESIGN.md](DESIGN.md).

## Status

Step 0 of the build order (DESIGN §11): ABI model, event decoder and types, for Cairo 0 and Cairo 1.

- `src/abi/codec.ts`: ABI type string → reader, compiled once per ABI.
- `src/abi/events.ts`: every event an ABI can emit with its selector path (`abiEvents`), and `createDecoder`.
- `src/abi/types.ts`: the same rules at the type level (`EventName`, `EventArgs`, `DecodedEvent`, `TypeOf`).

## Commands

```
pnpm install
pnpm test        # decoder on real mainnet events, compared with starknet.js on every event
pnpm typecheck   # includes the type tests (test/*.test-d.ts) on the real ABIs
pnpm fixtures    # refetch test/fixtures from mainnet (needs KASBAH_RPC_URL in .env, see .env.example)
```

Node 24+. Fixtures: Ekubo Core (Cairo 1, flat and nested variants), STRK (OpenZeppelin ERC20, key members), two
Cairo 0 contracts (a pair and an ERC20).
