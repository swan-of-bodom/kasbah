import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  Many,
  normalizeRelation,
  One,
  type Relation,
} from "drizzle-orm";
import {
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  type ValueNode,
} from "graphql";
import type pg from "pg";
import { ConfigError } from "../config/errors.ts";
import { quote, type TableInfo } from "../db/table.ts";
import { chunks } from "../utils/chunks.ts";
import { asQueryError, QueryError } from "./reader.ts";

export type GraphqlContext = {
  client: pg.PoolClient;
  timeoutMs: number;
  /** Set by the schema on first use: the request's statement count, start time and batch loaders. */
  budget?: { statements: number; started: number; loaders: Map<string, Loader> };
};

/** SQL statements one GraphQL request may run (nested relations run one per level, or per parent for lists). */
const MAX_STATEMENTS = 500;
/** Keys one batched relation statement looks up at most. */
const KEYS_PER_STATEMENT = 1_000;

type Row = Record<string, unknown>;

const budgetOf = (ctx: GraphqlContext) =>
  (ctx.budget ??= { statements: 0, started: performance.now(), loaders: new Map() });

async function rows(ctx: GraphqlContext, text: string, params: unknown[]): Promise<Row[]> {
  const b = budgetOf(ctx);
  if (++b.statements > MAX_STATEMENTS)
    throw new QueryError(
      `query needs more than ${MAX_STATEMENTS} SQL statements: nest less or page smaller`,
    );
  if (performance.now() - b.started > ctx.timeoutMs)
    throw new QueryError(`query cancelled after ${ctx.timeoutMs} ms`);
  try {
    return (await ctx.client.query(text, params)).rows;
  } catch (e) {
    throw asQueryError(e, ctx.timeoutMs);
  }
}

type Loader = (key: unknown[]) => Promise<unknown>;

function createLoader(
  fetch: (keys: unknown[][]) => Promise<Map<string, unknown>>,
  missing: () => unknown,
): Loader {
  let pending:
    | Map<
        string,
        { key: unknown[]; resolve: ((v: unknown) => void)[]; reject: ((e: unknown) => void)[] }
      >
    | undefined;
  const flush = async (batch: NonNullable<typeof pending>) => {
    try {
      const keys = [...batch.values()].map((b) => b.key);
      const found = new Map<string, unknown>();
      for (const part of chunks(keys, KEYS_PER_STATEMENT))
        for (const [k, v] of await fetch(part)) found.set(k, v);
      for (const [k, b] of batch)
        for (const r of b.resolve) r(found.has(k) ? found.get(k) : missing());
    } catch (e) {
      for (const b of batch.values()) for (const r of b.reject) r(e);
    }
  };
  return (key) =>
    new Promise((resolve, reject) => {
      if (pending === undefined) {
        const batch = (pending = new Map());
        // After the resolvers of this tick have asked for their keys.
        setImmediate(() => {
          pending = undefined;
          void flush(batch);
        });
      }
      const k = JSON.stringify(key);
      const entry = pending.get(k) ?? { key, resolve: [], reject: [] };
      entry.resolve.push(resolve);
      entry.reject.push(reject);
      pending.set(k, entry);
    });
}

/** A relation between two tables of the schema, by record key and column key. */
export type RelationInfo = {
  from: string;
  name: string;
  to: string;
  kind: "one" | "many";
  /** Columns of `from` matched against `references` of `to`. */
  fields: string[];
  references: string[];
};

/** Relations declared with Drizzle's `relations()` among `schema`'s values (tables and relations, like a schema module). */
export function relationsOf(
  schema: Record<string, unknown>,
  tables: Record<string, TableInfo>,
): RelationInfo[] {
  const { tables: config, tableNamesMap } = extractTablesRelationalConfig(
    schema,
    createTableRelationsHelpers,
  );
  const keyOfTable = new Map(Object.entries(tables).map(([k, t]) => [t.table, k]));
  const columnKey = (key: string, column: unknown) => {
    const c = tables[key]!.columns.find((x) => x.column === column);
    if (c === undefined) throw new ConfigError(`relation on ${key}: column not in the table`);
    return c.key;
  };
  const out: RelationInfo[] = [];
  for (const t of Object.values(config)) {
    for (const [name, relation] of Object.entries(t.relations) as [string, Relation][]) {
      const from = keyOfTable.get(relation.sourceTable as never);
      const to = keyOfTable.get(relation.referencedTable as never);
      if (from === undefined || to === undefined)
        throw new ConfigError(`relation ${name}: both tables must be in the schema`);
      const n = normalizeRelation(config, tableNamesMap, relation);
      if (!(relation instanceof One) && !(relation instanceof Many)) continue;
      out.push({
        from,
        name,
        to,
        kind: relation instanceof One ? "one" : "many",
        fields: n.fields.map((c) => columnKey(from, c)),
        references: n.references.map((c) => columnKey(to, c)),
      });
    }
  }
  return out;
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
    if (
      (typeof v === "string" && INTEGER.test(v)) ||
      (typeof v === "number" && Number.isSafeInteger(v))
    )
      return String(v);
    throw new TypeError("BigInt takes a decimal string");
  },
  parseLiteral: (node: ValueNode) => {
    if ((node.kind === Kind.STRING || node.kind === Kind.INT) && INTEGER.test(node.value))
      return node.value;
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
  if (t === "integer" || t === "smallint" || t === "serial" || t === "smallserial")
    return GraphQLInt;
  if (t === "bigint" || t === "bigserial" || t.startsWith("numeric") || t.startsWith("decimal"))
    return GraphQLBigInt;
  if (t === "boolean") return GraphQLBoolean;
  if (t === "real" || t === "double precision") return GraphQLFloat;
  if (t === "json" || t === "jsonb") return GraphQLJSON;
  return GraphQLString;
}

const ordered = (s: Scalar) =>
  s === GraphQLInt || s === GraphQLBigInt || s === GraphQLFloat || s === GraphQLString;
const pascal = (s: string) => s.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());

/** `pools` → `pool` and `pools`; `position` → `position` and `positions`. */
export function fieldNames(key: string): { one: string; many: string } {
  return key.endsWith("s") && key.length > 1
    ? { one: key.slice(0, -1), many: key }
    : { one: key, many: `${key}s` };
}

const OrderDirection = new GraphQLEnumType({
  name: "OrderDirection",
  values: { asc: { value: "asc" }, desc: { value: "desc" } },
});

const PageInfo = new GraphQLObjectType({
  name: "PageInfo",
  fields: {
    hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    endCursor: { type: GraphQLString },
  },
});

/** Rows one list field returns at most (`limit`), and when `limit` is left out. */
const MAX_LIMIT = 1_000;
const DEFAULT_LIMIT = 100;

type Filter = Record<string, unknown> & { AND?: Filter[]; OR?: Filter[] };
const OPERATORS: Record<string, string> = {
  _not: "<>",
  _gt: ">",
  _gte: ">=",
  _lt: "<",
  _lte: "<=",
};

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

const encodeCursor = (values: unknown[]) =>
  Buffer.from(JSON.stringify(values)).toString("base64url");
function decodeCursor(cursor: string, length: number): unknown[] {
  try {
    const values = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(values) && values.length === length) return values;
  } catch {}
  throw new QueryError("invalid cursor");
}

type ListArgs = {
  where?: Filter | null;
  orderBy?: string | null;
  orderDirection: "asc" | "desc";
  limit: number;
  after?: string | null;
};

type ListArgDefs = Record<string, { type: GraphQLInputType; defaultValue?: unknown }>;

type Built = ReturnType<typeof tableType> & { reader: ReturnType<typeof tableReader> };

/**
 * A read-only GraphQL schema over the app's tables. Per table: `pool(id: ...)` by primary key, and
 * `pools(where, orderBy, orderDirection, limit, after)` with keyset paging. Numbers past 32 bits are `BigInt`
 * strings. Relations add fields: a to-one is the related object (batched, one statement per level), a to-many
 * a page with the same arguments as the top-level list.
 */
export function createGraphqlSchema(
  tables: Record<string, TableInfo>,
  relations: RelationInfo[] = [],
): GraphQLSchema {
  const query: GraphQLFieldConfigMap<unknown, GraphqlContext> = {};
  const built = new Map<string, Built>();
  for (const [key, info] of Object.entries(tables)) {
    const { one, many } = fieldNames(key);
    if (query[one] !== undefined || query[many] !== undefined)
      throw new ConfigError(`GraphQL field names for table ${key} collide`);
    const types = tableType(pascal(one), info);
    const reader = tableReader(info);
    query[one] = {
      type: types.type,
      args: types.pkArgs,
      resolve: (_, args: Record<string, unknown>, ctx) => reader.one(ctx, args),
    };
    query[many] = {
      type: new GraphQLNonNull(types.page),
      args: types.listArgs,
      resolve: (_, args: ListArgs, ctx) => reader.list(ctx, args),
    };
    built.set(key, { ...types, reader });
  }
  // Relation fields go in last, once every table's type exists.
  for (const r of relations) {
    const from = built.get(r.from)!;
    if (from.fields[r.name] !== undefined)
      throw new ConfigError(
        `relation ${r.from}.${r.name} has the name of a column: rename one (e.g. column ${r.name}Id)`,
      );
    from.fields[r.name] = relationField(r, tables[r.from]!, built.get(r.to)!);
  }
  query._meta = metaField();
  return new GraphQLSchema({ query: new GraphQLObjectType({ name: "Query", fields: query }) });
}

function tableType(typeName: string, info: TableInfo) {
  const scalars = new Map(info.columns.map((c) => [c.key, scalarOf(c.column.getSQLType())]));
  const notNull = (c: TableInfo["columns"][number]) =>
    c.column.notNull || info.primaryKey.includes(c);
  const fields: GraphQLFieldConfigMap<unknown, GraphqlContext> = {};
  for (const c of info.columns) {
    const s = scalars.get(c.key)!;
    fields[c.key] = { type: (notNull(c) ? new GraphQLNonNull(s) : s) as GraphQLOutputType };
  }
  const type = new GraphQLObjectType({ name: typeName, fields: () => fields });
  // Keyset paging needs a total order without NULLs: only non-null columns, primary key as tiebreak.
  const sortable = info.columns.filter((c) => notNull(c) && ordered(scalars.get(c.key)!));
  const orderBy = new GraphQLEnumType({
    name: `${typeName}OrderBy`,
    values: Object.fromEntries(sortable.map((c) => [c.key, { value: c.key }])),
  });
  const page = new GraphQLObjectType({
    name: `${typeName}Page`,
    fields: {
      items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type))) },
      pageInfo: { type: new GraphQLNonNull(PageInfo) },
    },
  });
  const pkArgs: Record<string, { type: GraphQLInputType }> = {};
  for (const c of info.primaryKey)
    pkArgs[c.key] = { type: new GraphQLNonNull(scalars.get(c.key)!) };
  const listArgs: ListArgDefs = {
    where: { type: filterType(typeName, info, scalars) },
    orderBy: { type: orderBy },
    orderDirection: { type: OrderDirection, defaultValue: "asc" },
    limit: { type: GraphQLInt, defaultValue: DEFAULT_LIMIT },
    after: { type: GraphQLString },
  };
  return { type, page, fields, pkArgs, listArgs };
}

function filterType(
  typeName: string,
  info: TableInfo,
  scalars: Map<string, ReturnType<typeof scalarOf>>,
): GraphQLInputObjectType {
  const fields: GraphQLInputFieldConfigMap = {};
  const filter: GraphQLInputObjectType = new GraphQLInputObjectType({
    name: `${typeName}Filter`,
    fields: () => {
      fields.AND = { type: new GraphQLList(new GraphQLNonNull(filter)) };
      fields.OR = { type: new GraphQLList(new GraphQLNonNull(filter)) };
      for (const c of info.columns) {
        const s = scalars.get(c.key)!;
        if (s === GraphQLJSON) continue;
        fields[c.key] = { type: s };
        fields[`${c.key}_not`] = { type: s };
        fields[`${c.key}_in`] = { type: new GraphQLList(new GraphQLNonNull(s)) };
        fields[`${c.key}_not_in`] = { type: new GraphQLList(new GraphQLNonNull(s)) };
        if (ordered(s) && s !== GraphQLString) {
          for (const op of ["_gt", "_gte", "_lt", "_lte"]) fields[`${c.key}${op}`] = { type: s };
        }
      }
      return fields;
    },
  });
  return filter;
}

const emptyPage = () => ({ items: [], pageInfo: { hasNextPage: false, endCursor: null } });

function toPage(found: Row[], args: ListArgs, keys: string[]) {
  const items = found.slice(0, args.limit);
  const last = items.at(-1);
  return {
    items,
    pageInfo: {
      hasNextPage: found.length > args.limit,
      endCursor: last === undefined ? null : encodeCursor(keys.map((k) => last[k])),
    },
  };
}

function tableReader(info: TableInfo) {
  const select = info.columns.map((c) => `${quote(c.column.name)} AS ${quote(c.key)}`).join(", ");
  const table = quote(info.name);
  const columnName = (k: string) => quote(info.columns.find((c) => c.key === k)!.column.name);
  const pageParts = (args: ListArgs, params: unknown[], extra?: string) => {
    if (args.limit < 1 || args.limit > MAX_LIMIT)
      throw new QueryError(`limit must be between 1 and ${MAX_LIMIT}`);
    const keys = [
      ...new Set([
        ...(args.orderBy == null ? [] : [args.orderBy]),
        ...info.primaryKey.map((c) => c.key),
      ]),
    ];
    const columns = keys.map(columnName);
    const dir = args.orderDirection === "desc" ? "DESC" : "ASC";
    let where = whereSql(info, args.where ?? undefined, params);
    if (extra !== undefined) where = `(${where}) AND ${extra}`;
    if (args.after != null) {
      const placeholders = decodeCursor(args.after, keys.length).map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      where = `(${where}) AND (${columns.join(", ")}) ${dir === "ASC" ? ">" : "<"} (${placeholders.join(", ")})`;
    }
    return {
      keys,
      sql: `SELECT ${select} FROM ${table} WHERE ${where} ORDER BY ${columns.map((c) => `${c} ${dir}`).join(", ")} LIMIT ${args.limit + 1}`,
    };
  };
  const placeholders = (values: unknown[], params: unknown[], types?: string[]) =>
    values
      .map((v, j) => {
        params.push(v);
        return types === undefined ? `$${params.length}` : `$${params.length}::${types[j]}`;
      })
      .join(", ");

  return {
    one: async (ctx: GraphqlContext, args: Record<string, unknown>) => {
      const params: unknown[] = [];
      const where = info.primaryKey.map((c) => {
        params.push(args[c.key]);
        return `${quote(c.column.name)} = $${params.length}`;
      });
      const found = await rows(
        ctx,
        `SELECT ${select} FROM ${table} WHERE ${where.join(" AND ")}`,
        params,
      );
      return found[0] ?? null;
    },
    list: async (ctx: GraphqlContext, args: ListArgs) => {
      const params: unknown[] = [];
      const { keys, sql } = pageParts(args, params);
      return toPage(await rows(ctx, sql, params), args, keys);
    },
    pagesFor: async (
      ctx: GraphqlContext,
      args: ListArgs,
      match: string[],
      parents: unknown[][],
    ) => {
      const params: unknown[] = [];
      const types = match.map((k) => info.columns.find((c) => c.key === k)!.column.getSQLType());
      const tuples = parents.map((p, i) => `(${placeholders(p, params, types)}, ${i})`);
      const { keys, sql } = pageParts(
        args,
        params,
        match.map((k, j) => `${columnName(k)} = _k.c${j}`).join(" AND "),
      );
      const found = await rows(
        ctx,
        `SELECT _k._i AS "__parent", _t.* FROM (VALUES ${tuples.join(", ")}) AS _k(${match.map((_, j) => `c${j}`).join(", ")}, _i)
        CROSS JOIN LATERAL (${sql}) AS _t`,
        params,
      );
      const byParent = new Map<number, Row[]>();
      for (const r of found) {
        const i = r.__parent as number;
        delete r.__parent;
        byParent.set(i, [...(byParent.get(i) ?? []), r]);
      }
      return new Map(
        parents.map((p, i) => [JSON.stringify(p), toPage(byParent.get(i) ?? [], args, keys)]),
      );
    },
    byColumns: (ctx: GraphqlContext, columns: string[], keys: unknown[][]) => {
      const params: unknown[] = [];
      const tuples = keys.map((k) => `(${placeholders(k, params)})`);
      return rows(
        ctx,
        `SELECT ${select} FROM ${table} WHERE (${columns.map(columnName).join(", ")}) IN (${tuples.join(", ")})`,
        params,
      );
    },
  };
}

function loaderFor(ctx: GraphqlContext, id: string, make: () => Loader): Loader {
  const { loaders } = budgetOf(ctx);
  let load = loaders.get(id);
  if (load === undefined) {
    load = make();
    loaders.set(id, load);
  }
  return load;
}

function relationField(
  r: RelationInfo,
  from: TableInfo,
  to: Built,
): GraphQLFieldConfig<unknown, GraphqlContext> {
  const keyOf = (parent: unknown) => {
    const values = r.fields.map((k) => (parent as Row)[k]);
    return values.some((v) => v === null || v === undefined) ? undefined : values;
  };
  if (r.kind === "one") {
    const id = `${r.from}.${r.name}`;
    const notNull = r.fields.every((k) => from.columns.find((c) => c.key === k)!.column.notNull);
    return {
      type: notNull ? new GraphQLNonNull(to.type) : to.type,
      resolve: (parent, _, ctx) => {
        const values = keyOf(parent);
        if (values === undefined) return null;
        const load = loaderFor(ctx, id, () =>
          createLoader(
            async (keys) =>
              new Map(
                (await to.reader.byColumns(ctx, r.references, keys)).map((row) => [
                  JSON.stringify(r.references.map((k) => row[k])),
                  row,
                ]),
              ),
            () => null,
          ),
        );
        return load(values);
      },
    };
  }
  return {
    type: new GraphQLNonNull(to.page),
    args: to.listArgs,
    resolve: (parent, args: ListArgs, ctx) => {
      const values = keyOf(parent);
      if (values === undefined) return emptyPage();
      const load = loaderFor(ctx, `${r.from}.${r.name}:${JSON.stringify(args)}`, () =>
        createLoader((keys) => to.reader.pagesFor(ctx, args, r.references, keys), emptyPage),
      );
      return load(values);
    },
  };
}

function metaField(): GraphQLFieldConfig<unknown, GraphqlContext> {
  return {
    type: new GraphQLObjectType({
      name: "Meta",
      fields: { checkpoint: { type: GraphQLInt }, phase: { type: GraphQLString } },
    }),
    resolve: async (_, __, ctx) => {
      const found = await rows(
        ctx,
        `SELECT key, value FROM _kasbah_meta WHERE key IN ('checkpoint', 'phase')`,
        [],
      );
      const meta = Object.fromEntries(found.map((r) => [r.key, r.value]));
      return { checkpoint: meta.checkpoint ?? null, phase: meta.phase ?? null };
    },
  };
}
