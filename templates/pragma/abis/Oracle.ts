// Pragma oracle (mainnet): the part of its ABI the template calls, `get_data_median` and the types it takes and
// returns. The whole ABI comes from `starknet_getClassAt` on the oracle.
export default [
  {
    type: "interface",
    name: "pragma::oracle::oracle::IOracleABI",
    items: [
      {
        type: "function",
        name: "get_data_median",
        inputs: [
          {
            name: "data_type",
            type: "pragma::entry::structs::DataType",
          },
        ],
        outputs: [
          {
            type: "pragma::entry::structs::PragmaPricesResponse",
          },
        ],
        state_mutability: "view",
      },
    ],
  },
  {
    type: "enum",
    name: "pragma::entry::structs::DataType",
    variants: [
      {
        name: "SpotEntry",
        type: "core::felt252",
      },
      {
        name: "FutureEntry",
        type: "(core::felt252, core::integer::u64)",
      },
      {
        name: "GenericEntry",
        type: "core::felt252",
      },
    ],
  },
  {
    type: "struct",
    name: "pragma::entry::structs::PragmaPricesResponse",
    members: [
      {
        name: "price",
        type: "core::integer::u128",
      },
      {
        name: "decimals",
        type: "core::integer::u32",
      },
      {
        name: "last_updated_timestamp",
        type: "core::integer::u64",
      },
      {
        name: "num_sources_aggregated",
        type: "core::integer::u32",
      },
      {
        name: "expiration_timestamp",
        type: "core::option::Option::<core::integer::u64>",
      },
    ],
  },
] as const;
