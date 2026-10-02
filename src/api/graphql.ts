import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  type ValueNode,
} from "graphql";
import type pg from "pg";
import { quote, type TableInfo } from "../db/table.ts";
import { asQueryError, QueryError } from "./reader.ts";

export type GraphqlContext = { client: pg.PoolClient; timeoutMs: number };

async function rows(ctx: GraphqlContext, text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  try {
    return (await ctx.client.query(text, params)).rows;
  } catch (e) {
    throw asQueryError(e, ctx.timeoutMs);
  }
}

const INTEGER = /^-?\d+$/;

/** Integers too big for Int (u64, u128, u256, felts): decimal strings both ways. */
export const GraphQLBigInt = new GraphQLScalarType({
  name: "BigInt",
  description: "An integer of any size, as a decimal string.",
  serialize: (v) => {
    const s = typeof v === "bigint" ? v.toString() : String(v);
    if (!INTEGER.test(s)) throw new TypeError(`not an integer: ${s}`);
    return s;
  },
  parseValue: (v) => {
    if ((typeof v === "string" && INTEGER.test(v)) || (typeof v === "number" && Number.isSafeInteger(v))) return String(v);
    throw new TypeError("BigInt takes a decimal string");
  },
  parseLiteral: (node: ValueNode) => {
    if ((node.kind === Kind.STRING || node.kind === Kind.INT) && INTEGER.test(node.value)) return node.value;
    throw new TypeError("BigInt takes a decimal string");
  },
});

const parseJsonLiteral = (node: ValueNode): unknown => {
  switch (node.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return node.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map(parseJsonLiteral);
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((f) => [f.name.value, parseJsonLiteral(f.value)]));
    default:
      throw new TypeError("variables are not allowed inside JSON literals");
  }
};

export const GraphQLJSON = new GraphQLScalarType({
  name: "JSON",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: parseJsonLiteral,
});

type Scalar = GraphQLScalarType;

function scalarOf(sqlType: string): Scalar {
  const t = sqlType.toLowerCase();
  if (t === "integer" || t === "smallint" || t === "serial" || t === "smallserial") return GraphQLInt;
  if (t === "bigint" || t === "bigserial" || t.startsWith("numeric") || t.startsWith("decimal")) return GraphQLBigInt;
  if (t === "boolean") return GraphQLBoolean;
  if (t === "real" || t === "double precision") return GraphQLFloat;
  if (t === "json" || t === "jsonb") return GraphQLJSON;
  return GraphQLString;
}

const ordered = (s: Scalar) => s === GraphQLInt || s === GraphQLBigInt || s === GraphQLFloat || s === GraphQLString;
const pascal = (s: string) => s.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());

/** `pools` → `pool` and `pools`; `position` → `position` and `positions`. */
export function fieldNames(key: string): { one: string; many: string } {
  return key.endsWith("s") && key.length > 1 ? { one: key.slice(0, -1), many: key } : { one: key, many: `${key}s` };
}

const OrderDirection = new GraphQLEnumType({ name: "OrderDirection", values: { asc: { value: "asc" }, desc: { value: "desc" } } });

const PageInfo = new GraphQLObjectType({
  name: "PageInfo",
  fields: { hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) }, endCursor: { type: GraphQLString } },
});

const MAX_LIMIT = 1_000;

type Filter = Record<string, unknown> & { AND?: Filter[]; OR?: Filter[] };
const OPERATORS: Record<string, string> = { _not: "<>", _gt: ">", _gte: ">=", _lt: "<", _lte: "<=" };

function whereSql(info: TableInfo, f: Filter | undefined, params: unknown[]): string {
  if (f == null) return "TRUE";
  const byKey = new Map(info.columns.map((c) => [c.key, c.column.name]));
  const parts: string[] = [];
  for (const [field, value] of Object.entries(f)) {
    if (value === undefined) continue;
    if (field === "AND" || field === "OR" || (value === null && field.endsWith("_in"))) {
      if (value === null) continue;
      const subs = (value as Filter[]).map((s) => `(${whereSql(info, s, params)})`);
      if (subs.length > 0) parts.push(`(${subs.join(field === "AND" ? " AND " : " OR ")})`);
      continue;
    }
    const m = /^(.*?)(_not_in|_in|_not|_gte|_gt|_lte|_lt)?$/.exec(field)!;
    const column = quote(byKey.get(m[1]!)!);
    const op = m[2] ?? "";
    if (op === "_in" || op === "_not_in") {
      params.push(value);
      parts.push(`${op === "_in" ? "" : "NOT "}${column} = ANY($${params.length})`);
    } else if (value === null) {
      parts.push(`${column} IS ${op === "_not" ? "NOT " : ""}NULL`);
    } else {
      params.push(value);
      parts.push(`${column} ${OPERATORS[op] ?? "="} $${params.length}`);
    }
  }
  return parts.length === 0 ? "TRUE" : parts.join(" AND ");
}

const encodeCursor = (values: unknown[]) => Buffer.from(JSON.stringify(values)).toString("base64url");
function decodeCursor(cursor: string, length: number): unknown[] {
  try {
    const values = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(values) && values.length === length) return values;
  } catch {}
  throw new QueryError("invalid cursor");
}

/**
 * A read-only GraphQL schema over the app's tables. Per table: `pool(id: ...)` by primary key, and
 * `pools(where, orderBy, orderDirection, limit, after)` with keyset paging. Numbers past 32 bits are `BigInt`
 * strings.
 */
export function createGraphqlSchema(tables: Record<string, TableInfo>): GraphQLSchema {
  const query: GraphQLFieldConfigMap<unknown, GraphqlContext> = {};

  for (const [key, info] of Object.entries(tables)) {
    const { one, many } = fieldNames(key);
    if (query[one] !== undefined || query[many] !== undefined) throw new Error(`GraphQL field names for table ${key} collide`);
    const typeName = pascal(one);
    const scalars = new Map(info.columns.map((c) => [c.key, scalarOf(c.column.getSQLType())]));
    const notNull = (c: TableInfo["columns"][number]) => c.column.notNull || info.primaryKey.includes(c);

    const fields: GraphQLFieldConfigMap<unknown, GraphqlContext> = {};
    for (const c of info.columns) {
      const s = scalars.get(c.key)!;
      fields[c.key] = { type: (notNull(c) ? new GraphQLNonNull(s) : s) as GraphQLOutputType };
    }
    const type = new GraphQLObjectType({ name: typeName, fields });

    const filterFields: GraphQLInputFieldConfigMap = {};
    const filter: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: `${typeName}Filter`,
      fields: () => {
        filterFields.AND = { type: new GraphQLList(new GraphQLNonNull(filter)) };
        filterFields.OR = { type: new GraphQLList(new GraphQLNonNull(filter)) };
        for (const c of info.columns) {
          const s = scalars.get(c.key)!;
          if (s === GraphQLJSON) continue;
          filterFields[c.key] = { type: s };
          filterFields[`${c.key}_not`] = { type: s };
          filterFields[`${c.key}_in`] = { type: new GraphQLList(new GraphQLNonNull(s)) };
          filterFields[`${c.key}_not_in`] = { type: new GraphQLList(new GraphQLNonNull(s)) };
          if (ordered(s) && s !== GraphQLString) {
            for (const op of ["_gt", "_gte", "_lt", "_lte"]) filterFields[`${c.key}${op}`] = { type: s };
          }
        }
        return filterFields;
      },
    });

    // Keyset paging needs a total order without NULLs: only non-null columns, primary key as tiebreak.
    const sortable = info.columns.filter((c) => notNull(c) && ordered(scalars.get(c.key)!));
    const orderBy = new GraphQLEnumType({ name: `${typeName}OrderBy`, values: Object.fromEntries(sortable.map((c) => [c.key, { value: c.key }])) });
    const page = new GraphQLObjectType({
      name: `${typeName}Page`,
      fields: { items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type))) }, pageInfo: { type: new GraphQLNonNull(PageInfo) } },
    });

    const select = info.columns.map((c) => `${quote(c.column.name)} AS ${quote(c.key)}`).join(", ");
    const table = quote(info.name);
    const pkArgs: Record<string, { type: GraphQLInputType }> = {};
    for (const c of info.primaryKey) pkArgs[c.key] = { type: new GraphQLNonNull(scalars.get(c.key)!) };

    query[one] = {
      type,
      args: pkArgs,
      resolve: async (_, args: Record<string, unknown>, ctx) => {
        const params: unknown[] = [];
        const where = info.primaryKey.map((c) => {
          params.push(args[c.key]);
          return `${quote(c.column.name)} = $${params.length}`;
        });
        return (await rows(ctx, `SELECT ${select} FROM ${table} WHERE ${where.join(" AND ")}`, params))[0] ?? null;
      },
    };

    query[many] = {
      type: new GraphQLNonNull(page),
      args: {
        where: { type: filter },
        orderBy: { type: orderBy },
        orderDirection: { type: OrderDirection, defaultValue: "asc" },
        limit: { type: GraphQLInt, defaultValue: 100 },
        after: { type: GraphQLString },
      },
      resolve: async (_, args: { where?: Filter | null; orderBy?: string | null; orderDirection: "asc" | "desc"; limit: number; after?: string | null }, ctx) => {
        if (args.limit < 1 || args.limit > MAX_LIMIT) throw new QueryError(`limit must be between 1 and ${MAX_LIMIT}`);
        const params: unknown[] = [];
        const keys = [...new Set([...(args.orderBy == null ? [] : [args.orderBy]), ...info.primaryKey.map((c) => c.key)])];
        const columns = keys.map((k) => quote(info.columns.find((c) => c.key === k)!.column.name));
        const dir = args.orderDirection === "desc" ? "DESC" : "ASC";
        let where = whereSql(info, args.where ?? undefined, params);
        if (args.after != null) {
          const values = decodeCursor(args.after, keys.length);
          const placeholders = values.map((v) => {
            params.push(v);
            return `$${params.length}`;
          });
          where = `(${where}) AND (${columns.join(", ")}) ${dir === "ASC" ? ">" : "<"} (${placeholders.join(", ")})`;
        }
        const order = columns.map((c) => `${c} ${dir}`).join(", ");
        const found = await rows(ctx, `SELECT ${select} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${args.limit + 1}`, params);
        const hasNextPage = found.length > args.limit;
        const items = found.slice(0, args.limit);
        const last = items.at(-1) as Record<string, unknown> | undefined;
        return { items, pageInfo: { hasNextPage, endCursor: last === undefined ? null : encodeCursor(keys.map((k) => last[k])) } };
      },
    };
  }

  query._meta = {
    type: new GraphQLObjectType({
      name: "Meta",
      fields: { checkpoint: { type: GraphQLInt }, phase: { type: GraphQLString } },
    }),
    resolve: async (_, __, ctx) => {
      const meta = Object.fromEntries((await rows(ctx, `SELECT key, value FROM _kasbah_meta WHERE key IN ('checkpoint', 'phase')`, [])).map((r) => [r.key, r.value]));
      return { checkpoint: meta.checkpoint ?? null, phase: meta.phase ?? null };
    },
  };

  return new GraphQLSchema({ query: new GraphQLObjectType({ name: "Query", fields: query }) });
}
