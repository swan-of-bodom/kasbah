/** A Starknet contract ABI as returned by `starknet_getClassAt` (Cairo 0 or Cairo 1), declared `as const`. */
export type Abi = readonly AbiItem[];

export type AbiItem =
  | AbiEvent
  | AbiStruct
  | AbiEnum
  | AbiFunction
  | AbiInterface
  | AbiImpl
  | AbiConstructor
  | AbiL1Handler;

export type AbiMember = { readonly name: string; readonly type: string };

/** Cairo 0: `keys[0]` is `sn_keccak(name)`, then the `keys` members, and `data` holds the rest. */
export type Cairo0Event = {
  readonly type: "event";
  readonly name: string;
  readonly keys: readonly AbiMember[];
  readonly data: readonly AbiMember[];
};

/** Cairo 1 before compiler 2.0: `keys[0]` is `sn_keccak(name)`, every input is in `data`. */
export type LegacyCairo1Event = {
  readonly type: "event";
  readonly name: string;
  readonly inputs: readonly AbiMember[];
};

export type EventMemberKind = "key" | "data" | "nested" | "flat";
export type EventMember = AbiMember & { readonly kind: EventMemberKind };

export type Cairo1EventStruct = {
  readonly type: "event";
  readonly name: string;
  readonly kind: "struct";
  readonly members: readonly EventMember[];
};

export type Cairo1EventEnum = {
  readonly type: "event";
  readonly name: string;
  readonly kind: "enum";
  readonly variants: readonly EventMember[];
};

export type AbiEvent = Cairo0Event | LegacyCairo1Event | Cairo1EventStruct | Cairo1EventEnum;

export type AbiStruct = {
  readonly type: "struct";
  readonly name: string;
  readonly members: readonly (AbiMember & { readonly offset?: number })[];
  readonly size?: number;
};

export type AbiEnum = {
  readonly type: "enum";
  readonly name: string;
  readonly variants: readonly AbiMember[];
};

export type AbiFunction = {
  readonly type: "function";
  readonly name: string;
  readonly inputs: readonly AbiMember[];
  readonly outputs: readonly ({ readonly type: string } & { readonly name?: string })[];
  readonly state_mutability?: "view" | "external";
  readonly stateMutability?: "view";
};

export type AbiInterface = {
  readonly type: "interface";
  readonly name: string;
  readonly items: readonly AbiFunction[];
};

export type AbiImpl = {
  readonly type: "impl";
  readonly name: string;
  readonly interface_name: string;
};

export type AbiConstructor = {
  readonly type: "constructor";
  readonly name: string;
  readonly inputs: readonly AbiMember[];
  readonly outputs?: readonly unknown[];
};

export type AbiL1Handler = {
  readonly type: "l1_handler";
  readonly name: string;
  readonly inputs: readonly AbiMember[];
  readonly outputs: readonly unknown[];
  readonly state_mutability?: string;
};
