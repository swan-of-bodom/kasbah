import DataLoader from "dataloader";
import {
  and,
  arrayContained,
  arrayContains,
  asc,
  type Column,
  count,
  createTableRelationsHelpers,
  desc,
  eq,
  extractTablesRelationalConfig,
  getTableColumns,
  getTableName,
  gt,
  gte,
  ilike,
  inArray,
  is,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  Many,
  ne,
  not,
  notIlike,
  notInArray,
  notLike,
  One,
  or,
  type SQL,
  type TableRelationalConfig,
} from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgBigInt53, PgInteger, PgSerial, type PgTable } from "drizzle-orm/pg-core";
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
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
  type GraphQLResolveInfo,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";
import superjson from "superjson";
import { ConfigError } from "../../config/errors.ts";
import { isBignum, isHex } from "../../config/schema.ts";
import { tableInfo } from "../../db/table.ts";
import { approxBytes, heapLimit } from "../../utils/memory.ts";
import type { Tables } from "../context.ts";
import { asQueryError, QueryError } from "../reader.ts";
import type { Status } from "../status.ts";
import { GraphQLJSON } from "./json.ts";

type Parent = Record<string, any>;
type Row = Record<string, unknown>;

/** What each GraphQL request's resolvers get. */
export type GraphqlContext = {
  /** Read-only Drizzle over the app's tables, on the API's reader. */
  db: NodePgDatabase<Tables>;
  getDataLoader: ReturnType<typeof buildDataLoaderCache>;
  status: () => Promise<Status>;
  budget: RequestBudget;
};

type PluralArgs = {
  where?: { [key: string]: number | string };
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: "asc" | "desc";
};

/** Rows a list returns when the query doesn't say. */
const DEFAULT_LIMIT = 50;
/** Rows a list returns at most: one page stays small for the client and the API alike. */
const MAX_LIMIT = 1000;
/** Rows one batched lookup of related rows asks for at most: keeps each statement's parameters few. */
const MAX_BATCH_SIZE = 1_000;
/** Share of the heap one request's rows may take: lists nested in lists multiply, and one request must not exhaust it. */
const REQUEST_HEAP_SHARE = 1 / 16;

/** A mistake in the query: its message reaches the client, in production too. */
function fail(message: string): never {
  throw new GraphQLError(message);
}

/**
 * What one request may read: rows held at once (a share of the heap) and time (the reader's timeout, over all its
 * statements). Every statement a request runs goes through `read`, which also turns errors the query caused
 * (Postgres refusing a value, a timeout) into GraphQL errors.
 */
export class RequestBudget {
  #bytes = 0;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #deadline: number;

  constructor({ timeoutMs, maxBytes }: { timeoutMs: number; maxBytes?: number }) {
    this.#timeoutMs = timeoutMs;
    this.#maxBytes = maxBytes ?? Math.floor(heapLimit() * REQUEST_HEAP_SHARE);
    this.#deadline = performance.now() + timeoutMs;
  }

  async read<T>(query: PromiseLike<T>): Promise<T> {
    if (performance.now() > this.#deadline) fail(`query cancelled after ${this.#timeoutMs} ms`);
    let result: T;
    try {
      result = await query;
    } catch (e) {
      const error = asQueryError(e, this.#timeoutMs);
      if (error instanceof QueryError) throw new GraphQLError(error.message);
      throw error instanceof DrizzleQueryError ? (error.cause ?? error) : error;
    }
    this.#bytes += approxBytes(result);
    if (this.#bytes > this.#maxBytes)
      fail(
        `query reads more than ${(this.#maxBytes / 2 ** 20).toFixed(1)} MB of rows: ask for fewer (limit) or nest fewer lists`,
      );
    return result;
  }
}

/**
 * The GraphQL schema of the app's tables. Per table (by its key in `schema`, e.g. `pool`): the row by primary key
 * (`pool(id: …)`) and a page (`pools(where, orderBy, orderDirection, before, after, limit, offset)` with `items`,
 * `pageInfo` and `totalCount`); Drizzle `relations()` add a field per relation. `_meta { status }` is
 * `GET /status`.
 */
export function buildGraphQLSchema({ schema }: { schema: Tables }): GraphQLSchema {
  const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const tables = Object.values(tablesConfig.tables) as TableRelationalConfig[];

  const entityFilterTypes: Record<string, GraphQLInputObjectType> = {};
  for (const table of tables) {
    const filterType: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: `${table.tsName}Filter`,
      fields: () => {
        const filterFields: GraphQLInputFieldConfigMap = {
          AND: { type: new GraphQLList(filterType) },
          OR: { type: new GraphQLList(filterType) },
        };

        for (const [columnName, column] of Object.entries(table.columns)) {
          const type = columnToGraphQLCore(column);

          if (type instanceof GraphQLList) {
            const baseType = innerType(type);
            for (const suffix of conditionSuffixes.universal)
              filterFields[`${columnName}${suffix}`] = { type: new GraphQLList(baseType) };
            for (const suffix of conditionSuffixes.plural)
              filterFields[`${columnName}${suffix}`] = { type: baseType };
          }

          if (type instanceof GraphQLScalarType || type instanceof GraphQLEnumType) {
            if (type.name === "JSON") continue;
            for (const suffix of conditionSuffixes.universal)
              filterFields[`${columnName}${suffix}`] = { type };
            for (const suffix of conditionSuffixes.singular)
              filterFields[`${columnName}${suffix}`] = { type: new GraphQLList(type) };

            if (["String", "ID"].includes(type.name)) {
              const suffixes = isHex(column)
                ? conditionSuffixes.string.filter((suffix) => !suffix.endsWith("_nocase"))
                : conditionSuffixes.string;
              for (const suffix of suffixes) filterFields[`${columnName}${suffix}`] = { type };
            }

            if (["Int", "Float", "BigInt", "Numeric"].includes(type.name)) {
              for (const suffix of conditionSuffixes.numeric)
                filterFields[`${columnName}${suffix}`] = { type };
            }
          }
        }

        return filterFields;
      },
    });
    entityFilterTypes[table.tsName] = filterType;
  }

  const entityTypes: Record<string, GraphQLObjectType<Parent, GraphqlContext>> = {};
  const entityPageTypes: Record<string, GraphQLObjectType> = {};

  for (const table of tables) {
    entityTypes[table.tsName] = new GraphQLObjectType({
      name: table.tsName,
      fields: () => {
        const fieldConfigMap: GraphQLFieldConfigMap<Parent, GraphqlContext> = {};

        for (const [columnName, column] of Object.entries(table.columns)) {
          const type = columnToGraphQLCore(column);
          fieldConfigMap[columnName] = { type: column.notNull ? new GraphQLNonNull(type) : type };
        }

        for (const [relationName, relation] of Object.entries(table.relations)) {
          if (fieldConfigMap[relationName] !== undefined)
            throw new ConfigError(
              `relation ${table.tsName}.${relationName} has the name of a column: rename one (e.g. column ${relationName}Id)`,
            );
          const referencedTable = tables.find((t) => t.dbName === relation.referencedTableName);
          if (referencedTable === undefined)
            throw new ConfigError(
              `relation ${table.tsName}.${relationName}: table "${relation.referencedTableName}" is not in the schema`,
            );

          const referencedEntityType = entityTypes[referencedTable.tsName]!;
          const referencedEntityPageType = entityPageTypes[referencedTable.tsName]!;
          const referencedEntityFilterType = entityFilterTypes[referencedTable.tsName]!;

          if (is(relation, One)) {
            const fields = relation.config?.fields ?? [];
            const references = relation.config?.references ?? [];
            if (fields.length !== references.length)
              throw new ConfigError(
                `relation ${table.tsName}.${relationName}: fields and references must be as many`,
              );

            fieldConfigMap[relationName] = {
              // Nullable whatever the columns: nothing guarantees the related row exists.
              type: referencedEntityType,
              resolve: (parent, _args, context) => {
                const loader = context.getDataLoader({ table: referencedTable });
                const rowFragment: Record<string, unknown> = {};
                for (let i = 0; i < references.length; i++)
                  rowFragment[getColumnTsName(references[i]!)] =
                    parent[getColumnTsName(fields[i]!)];
                return loader.load(encodeRowFragment(rowFragment));
              },
            };
          } else if (is(relation, Many)) {
            // The `one` on the other side gives the columns: the one named alike, else the first to this table.
            let oneRelation: One | undefined;
            if (relation.relationName !== undefined) {
              for (const r of Object.values(referencedTable.relations)) {
                if (is(r, One) && relation.relationName === r.relationName) {
                  oneRelation = r;
                  break;
                }
              }
            }
            if (oneRelation === undefined) {
              for (const r of Object.values(referencedTable.relations)) {
                if (is(r, One) && table.dbName === r.referencedTableName) {
                  oneRelation = r;
                  break;
                }
              }
            }
            if (oneRelation === undefined)
              throw new ConfigError(
                `relation ${table.tsName}.${relationName}: ${referencedTable.tsName} needs the one() relation back to ${table.tsName}`,
              );

            const fields = oneRelation.config?.fields ?? [];
            const references = oneRelation.config?.references ?? [];

            fieldConfigMap[relationName] = {
              type: referencedEntityPageType,
              args: {
                where: { type: referencedEntityFilterType },
                orderBy: { type: GraphQLString },
                orderDirection: { type: GraphQLString },
                before: { type: GraphQLString },
                after: { type: GraphQLString },
                limit: { type: GraphQLInt },
                offset: { type: GraphQLInt },
              },
              resolve: (parent, args: PluralArgs, context, info) => {
                const relationalConditions = [];
                for (let i = 0; i < references.length; i++)
                  relationalConditions.push(
                    eq(fields[i]!, parent[getColumnTsName(references[i]!)]),
                  );
                return executePluralQuery(
                  schema[referencedTable.tsName] as PgTable,
                  referencedTable.columns,
                  context,
                  args,
                  selectionIncludesField(info, "totalCount"),
                  relationalConditions,
                );
              },
            };
          } else {
            throw new ConfigError(
              `relation ${table.tsName}.${relationName}: only one() and many() are supported`,
            );
          }
        }

        return fieldConfigMap;
      },
    });

    entityPageTypes[table.tsName] = new GraphQLObjectType({
      name: `${table.tsName}Page`,
      fields: () => ({
        items: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(entityTypes[table.tsName]!))),
        },
        pageInfo: { type: new GraphQLNonNull(GraphQLPageInfo) },
        totalCount: { type: new GraphQLNonNull(GraphQLInt) },
      }),
    });
  }

  const queryFields: Record<string, GraphQLFieldConfig<Parent, GraphqlContext>> = {};
  const define = (name: string, field: GraphQLFieldConfig<Parent, GraphqlContext>) => {
    if (queryFields[name] !== undefined)
      throw new ConfigError(`two tables would have the GraphQL field ${name}: rename one`);
    queryFields[name] = field;
  };
  for (const table of tables) {
    const singularFieldName = table.tsName.charAt(0).toLowerCase() + table.tsName.slice(1);
    const pluralFieldName = `${singularFieldName}s`;

    define(singularFieldName, {
      type: entityTypes[table.tsName]!,
      args: Object.fromEntries(
        table.primaryKey.map((column) => [
          getColumnTsName(column),
          { type: new GraphQLNonNull(columnToGraphQLCore(column) as GraphQLInputType) },
        ]),
      ),
      // The arguments are a `where` of equalities on the primary key.
      resolve: (_parent, args, context) =>
        context.getDataLoader({ table }).load(encodeRowFragment(args)),
    });

    define(pluralFieldName, {
      type: new GraphQLNonNull(entityPageTypes[table.tsName]!),
      args: {
        where: { type: entityFilterTypes[table.tsName]! },
        orderBy: { type: GraphQLString },
        orderDirection: { type: GraphQLString },
        before: { type: GraphQLString },
        after: { type: GraphQLString },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
      },
      resolve: (_parent, args: PluralArgs, context, info) =>
        executePluralQuery(
          schema[table.tsName] as PgTable,
          table.columns,
          context,
          args,
          selectionIncludesField(info, "totalCount"),
        ),
    });
  }

  queryFields._meta = {
    type: GraphQLMeta,
    resolve: async (_source, _args, context) => ({ status: await context.status() }),
  };

  return new GraphQLSchema({
    // Listed first in the printed schema.
    types: [GraphQLJSON, GraphQLBigInt, GraphQLPageInfo, GraphQLViewPageInfo, GraphQLMeta],
    query: new GraphQLObjectType({ name: "Query", fields: queryFields }),
  });
}

const GraphQLPageInfo = new GraphQLObjectType({
  name: "PageInfo",
  fields: {
    hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    startCursor: { type: GraphQLString },
    endCursor: { type: GraphQLString },
  },
});

const GraphQLViewPageInfo = new GraphQLObjectType({
  name: "ViewPageInfo",
  fields: {
    hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const GraphQLBigInt = new GraphQLScalarType({
  name: "BigInt",
  serialize: (value) => String(value),
  parseValue: (value) => BigInt(value as string),
  parseLiteral: (value) => {
    if (value.kind === "StringValue") return BigInt(value.value);
    throw new Error(
      `Invalid value kind provided for field of type BigInt: ${value.kind}. Expected: StringValue`,
    );
  },
});

const GraphQLNumeric = new GraphQLScalarType({
  name: "Numeric",
  serialize: (value) => String(value),
  parseValue: (value) => String(value),
  parseLiteral: (value) => {
    if (value.kind === "StringValue") return String(value.value);
    throw new Error(
      `Invalid value kind provided for field of type BigInt: ${value.kind}. Expected: StringValue`,
    );
  },
});

const GraphQLMeta = new GraphQLObjectType({
  name: "Meta",
  fields: { status: { type: GraphQLJSON } },
});

function columnToGraphQLCore(column: Column): GraphQLOutputType {
  if (isBignum(column)) return GraphQLBigInt;
  if (isHex(column)) return GraphQLString;
  if (column.columnType === "PgNumeric") return GraphQLNumeric;

  switch (column.dataType) {
    case "boolean":
      return GraphQLBoolean;
    case "json":
      return GraphQLJSON;
    case "date":
      return GraphQLString;
    case "string":
      return GraphQLString;
    case "bigint":
      return GraphQLBigInt;
    case "number":
      return is(column, PgInteger) || is(column, PgSerial) || is(column, PgBigInt53)
        ? GraphQLInt
        : GraphQLFloat;
    case "buffer":
      return new GraphQLList(new GraphQLNonNull(GraphQLInt));
    case "array": {
      if (column.columnType === "PgVector" || column.columnType === "PgGeometry")
        return new GraphQLList(new GraphQLNonNull(GraphQLFloat));
      const base = (column as unknown as { baseColumn?: Column }).baseColumn;
      if (base === undefined) return unsupported(column);
      return new GraphQLList(new GraphQLNonNull(columnToGraphQLCore(base)));
    }
    default:
      return unsupported(column);
  }
}

function unsupported(column: Column): never {
  throw new ConfigError(
    `${getTableName(column.table)}.${column.name}: GraphQL has no type for ${column.getSQLType()}; use bignum(), hex() or another of Drizzle's column types`,
  );
}

function innerType(type: GraphQLOutputType): GraphQLScalarType | GraphQLEnumType {
  if (type instanceof GraphQLScalarType || type instanceof GraphQLEnumType) return type;
  if (type instanceof GraphQLList || type instanceof GraphQLNonNull) return innerType(type.ofType);
  throw new Error(`Type ${type.toString()} is not implemented`);
}

type Page = {
  items: Row[];
  totalCount: number | null;
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
};

async function executePluralQuery(
  table: PgTable,
  columns: Record<string, Column>,
  { db, budget }: GraphqlContext,
  args: PluralArgs,
  includeTotalCount: boolean,
  extraConditions: (SQL | undefined)[] = [],
): Promise<Page> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const offset = args.offset ?? 0;

  if (limit > MAX_LIMIT) fail(`Invalid limit. Got ${limit}, expected <=${MAX_LIMIT}.`);

  const orderBySchema = buildOrderBySchema(table, args);
  const orderBy = orderBySchema.map(([columnName, direction]) => {
    const column = columns[columnName] ?? unknownOrderBy(columnName);
    return direction === "asc" ? asc(column) : desc(column);
  });
  const orderByReversed = orderBySchema.map(([columnName, direction]) => {
    const column = columns[columnName] ?? unknownOrderBy(columnName);
    return direction === "asc" ? desc(column) : asc(column);
  });

  const whereConditions = buildWhereConditions(args.where, columns);

  const after = args.after ?? null;
  const before = args.before ?? null;

  if (after !== null && before !== null) fail("Cannot specify both before and after cursors.");
  if (after !== null && offset > 0) fail("Cannot specify both after cursor and offset.");
  if (before !== null && offset > 0) fail("Cannot specify both before cursor and offset.");

  const cursorCondition =
    after !== null
      ? buildCursorCondition(columns, orderBySchema, "after", decodeCursor(after))
      : before !== null
        ? buildCursorCondition(columns, orderBySchema, "before", decodeCursor(before))
        : undefined;

  let startCursor: string | null = null;
  let endCursor: string | null = null;
  let hasPreviousPage = false;
  let hasNextPage = false;

  const totalCountPromise = includeTotalCount
    ? budget
        .read(
          db
            .select({ count: count() })
            .from(table)
            .where(and(...whereConditions, ...extraConditions)),
        )
        .then((rows) => rows[0]?.count ?? null)
    : Promise.resolve(null);

  if (after === null && before === null) {
    const [rows, totalCount] = await Promise.all([
      budget.read(
        db
          .select()
          .from(table)
          .where(and(...whereConditions, ...extraConditions))
          .orderBy(...orderBy)
          .limit(limit + 1)
          .offset(offset),
      ),
      totalCountPromise,
    ]);

    if (rows.length === limit + 1) {
      rows.pop();
      hasNextPage = true;
    }

    if (offset === 0) {
      startCursor = rows.length > 0 ? encodeCursor(orderBySchema, rows[0]!) : null;
      endCursor = rows.length > 0 ? encodeCursor(orderBySchema, rows[rows.length - 1]!) : null;
    } else {
      hasPreviousPage = true;
    }

    return {
      items: rows,
      totalCount,
      pageInfo: { hasNextPage, hasPreviousPage, startCursor, endCursor },
    };
  }

  if (after !== null) {
    // One row more on each side: the cursor's own row, if it's still there, and the next page's first.
    const [rows, totalCount] = await Promise.all([
      budget.read(
        db
          .select()
          .from(table)
          .where(and(...whereConditions, cursorCondition, ...extraConditions))
          .orderBy(...orderBy)
          .limit(limit + 2)
          .offset(offset),
      ),
      totalCountPromise,
    ]);

    if (rows.length === 0) {
      return {
        items: rows,
        totalCount,
        pageInfo: { hasNextPage, hasPreviousPage, startCursor, endCursor },
      };
    }

    if (encodeCursor(orderBySchema, rows[0]!) === after) {
      rows.shift();
      hasPreviousPage = true;
    } else {
      rows.pop();
    }

    if (rows.length === limit + 1) {
      rows.pop();
      hasNextPage = true;
    }

    startCursor = rows.length > 0 ? encodeCursor(orderBySchema, rows[0]!) : null;
    endCursor = rows.length > 0 ? encodeCursor(orderBySchema, rows[rows.length - 1]!) : null;

    return {
      items: rows,
      totalCount,
      pageInfo: { hasNextPage, hasPreviousPage, startCursor, endCursor },
    };
  }

  const [rows, totalCount] = await Promise.all([
    budget
      .read(
        db
          .select()
          .from(table)
          .where(and(...whereConditions, cursorCondition, ...extraConditions))
          .orderBy(...orderByReversed)
          .limit(limit + 2)
          .offset(offset),
      )
      .then((rows) => rows.reverse()),
    totalCountPromise,
  ]);

  if (rows.length === 0) {
    return {
      items: rows,
      totalCount,
      pageInfo: { hasNextPage, hasPreviousPage, startCursor, endCursor },
    };
  }

  if (encodeCursor(orderBySchema, rows[rows.length - 1]!) === before) {
    rows.pop();
    hasNextPage = true;
  } else {
    rows.shift();
  }

  if (rows.length === limit + 1) {
    rows.shift();
    hasPreviousPage = true;
  }

  startCursor = rows.length > 0 ? encodeCursor(orderBySchema, rows[0]!) : null;
  endCursor = rows.length > 0 ? encodeCursor(orderBySchema, rows[rows.length - 1]!) : null;

  return {
    items: rows,
    totalCount,
    pageInfo: { hasNextPage, hasPreviousPage, startCursor, endCursor },
  };
}

const unknownOrderBy = (columnName: string): never =>
  fail(`Unknown column "${columnName}" used in orderBy argument`);

const conditionSuffixes = {
  universal: ["", "_not"],
  singular: ["_in", "_not_in"],
  plural: ["_has", "_not_has"],
  numeric: ["_gt", "_lt", "_gte", "_lte"],
  string: [
    "_contains",
    "_not_contains",
    "_starts_with",
    "_ends_with",
    "_not_starts_with",
    "_not_ends_with",
    "_contains_nocase",
    "_not_contains_nocase",
    "_starts_with_nocase",
    "_ends_with_nocase",
    "_not_starts_with_nocase",
    "_not_ends_with_nocase",
  ],
} as const;

type ConditionSuffix = (typeof conditionSuffixes)[keyof typeof conditionSuffixes][number];

// Longest first, so `_not_in` is not read as `_in`.
const conditionSuffixesByLengthDesc: ConditionSuffix[] = Object.values(conditionSuffixes)
  .flat()
  .sort((a, b) => b.length - a.length);

function buildWhereConditions(
  where: Record<string, any> | undefined,
  columns: Record<string, Column>,
): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [];
  if (where === undefined || where === null) return conditions;

  for (const [whereKey, rawValue] of Object.entries(where)) {
    if (whereKey === "AND" || whereKey === "OR") {
      if (!Array.isArray(rawValue))
        fail(`Invalid query: Expected an array for the ${whereKey} operator. Got: ${rawValue}`);
      const nestedConditions = (rawValue as Record<string, any>[]).flatMap((subWhere) =>
        buildWhereConditions(subWhere, columns),
      );
      if (nestedConditions.length > 0)
        conditions.push(whereKey === "AND" ? and(...nestedConditions) : or(...nestedConditions));
      continue;
    }

    const conditionSuffix = conditionSuffixesByLengthDesc.find((s) => whereKey.endsWith(s));
    if (conditionSuffix === undefined) fail(`Invalid query: Unknown where key ${whereKey}`);
    const columnName = whereKey.slice(0, whereKey.length - conditionSuffix.length);
    const column = columns[columnName];
    if (column === undefined)
      fail(`Invalid query: Where clause contains unknown column ${columnName}`);

    conditions.push(condition(column, conditionSuffix, rawValue));
  }

  return conditions;
}

function condition(column: Column, suffix: ConditionSuffix, value: any): SQL | undefined {
  const array = column.columnType === "PgArray";
  switch (suffix) {
    case "":
      if (array) return and(arrayContains(column, value), arrayContained(column, value));
      return value === null ? isNull(column) : eq(column, value);
    case "_not":
      if (array) return not(and(arrayContains(column, value), arrayContained(column, value))!);
      return value === null ? isNotNull(column) : ne(column, value);
    case "_in":
      return inArray(column, value);
    case "_not_in":
      return notInArray(column, value);
    case "_has":
      return arrayContains(column, [value]);
    case "_not_has":
      return not(arrayContains(column, [value]));
    case "_gt":
      return gt(column, value);
    case "_lt":
      return lt(column, value);
    case "_gte":
      return gte(column, value);
    case "_lte":
      return lte(column, value);
    case "_contains":
      return like(column, `%${value}%`);
    case "_not_contains":
      return notLike(column, `%${value}%`);
    case "_starts_with":
      return like(column, `${value}%`);
    case "_ends_with":
      return like(column, `%${value}`);
    case "_not_starts_with":
      return notLike(column, `${value}%`);
    case "_not_ends_with":
      return notLike(column, `%${value}`);
    case "_contains_nocase":
      return ilike(column, `%${value}%`);
    case "_not_contains_nocase":
      return notIlike(column, `%${value}%`);
    case "_starts_with_nocase":
      return ilike(column, `${value}%`);
    case "_ends_with_nocase":
      return ilike(column, `%${value}`);
    case "_not_starts_with_nocase":
      return notIlike(column, `${value}%`);
    case "_not_ends_with_nocase":
      return notIlike(column, `%${value}`);
  }
}

/** The order asked for, then any primary key column it leaves out, in the same direction: a total order for cursors. */
function buildOrderBySchema(table: PgTable, args: PluralArgs): [string, "asc" | "desc"][] {
  const userDirection = args.orderDirection ?? "asc";
  const userColumns: [string, "asc" | "desc"][] =
    args.orderBy !== undefined && args.orderBy !== null ? [[args.orderBy, userDirection]] : [];
  const missingPkColumns = tableInfo(table)
    .primaryKey.filter(({ key }) => !userColumns.some(([name]) => name === key))
    .map(({ key }): [string, "asc" | "desc"] => [key, userDirection]);
  return [...userColumns, ...missingPkColumns];
}

function encodeCursor(orderBySchema: [string, "asc" | "desc"][], row: Row): string {
  return encodeRowFragment(Object.fromEntries(orderBySchema.map(([name]) => [name, row[name]])));
}

function decodeCursor(cursor: string): Row {
  try {
    const decoded = decodeRowFragment(cursor);
    if (decoded !== null && typeof decoded === "object") return decoded;
  } catch {}
  return fail("Invalid cursor");
}

function encodeRowFragment(rowFragment: Row): string {
  return Buffer.from(superjson.stringify(rowFragment)).toString("base64");
}

function decodeRowFragment(encodedRowFragment: string): Row {
  return superjson.parse(Buffer.from(encodedRowFragment, "base64").toString());
}

/** Rows after (or before) the cursor's in the order: `a > x OR (a = x AND (b > y OR (b = y AND c >= z)))`. */
function buildCursorCondition(
  columns: Record<string, Column>,
  orderBySchema: [string, "asc" | "desc"][],
  direction: "after" | "before",
  cursorObject: Row,
): SQL | undefined {
  const cursorColumns = orderBySchema.map(([columnName, orderDirection]) => {
    const column = columns[columnName] ?? unknownOrderBy(columnName);
    const value = cursorObject[columnName];
    const forward = (direction === "after") === (orderDirection === "asc");
    const [comparator, comparatorOrEquals] = forward ? [gt, gte] : [lt, lte];
    return { column, value, comparator, comparatorOrEquals };
  });

  const buildCondition = (index: number): SQL | undefined => {
    const current = cursorColumns[index]!;
    if (index === cursorColumns.length - 1)
      return current.comparatorOrEquals(current.column, current.value);
    return or(
      current.comparator(current.column, current.value),
      and(eq(current.column, current.value), buildCondition(index + 1)),
    );
  };

  return buildCondition(0);
}

/**
 * Per request: a loader per table that gathers the rows asked for by key in one tick (a page's to-one relations)
 * into one statement.
 */
export function buildDataLoaderCache({ db, budget }: Pick<GraphqlContext, "db" | "budget">) {
  const dataLoaderMap = new Map<TableRelationalConfig, DataLoader<string, Row | undefined>>();
  return ({ table }: { table: TableRelationalConfig }) => {
    const baseQuery = (db.query as Record<string, any>)[table.tsName];
    if (baseQuery === undefined)
      throw new Error(`Internal error: Unknown table "${table.tsName}" in data loader cache`);

    let dataLoader = dataLoaderMap.get(table);
    if (dataLoader === undefined) {
      dataLoader = new DataLoader(
        async (encodedIds) => {
          const decodedRowFragments = encodedIds.map(decodeRowFragment);
          const idConditions = decodedRowFragments.map((fragment) =>
            and(...buildWhereConditions(fragment, table.columns)),
          );
          const rows: Row[] = await budget.read(
            baseQuery.findMany({ where: or(...idConditions), limit: encodedIds.length }),
          );

          // Back in the keys' order, each key in the form its column reads back (e.g. a bigint from a string).
          return decodedRowFragments
            .map((fragment) =>
              Object.fromEntries(
                Object.entries(fragment).map(([col, val]) => {
                  const column = table.columns[col];
                  if (column === undefined)
                    throw new Error(
                      `Unknown column '${table.tsName}.${col}' used in dataloader row ID fragment`,
                    );
                  return [col, normalizeColumn(column, val)];
                }),
              ),
            )
            .map((fragment) =>
              rows.find((row) => Object.entries(fragment).every(([col, val]) => row[col] === val)),
            );
        },
        { maxBatchSize: MAX_BATCH_SIZE },
      );
      dataLoaderMap.set(table, dataLoader);
    }
    return dataLoader;
  };
}

function normalizeColumn(column: Column, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && column.columnType === "PgArray") {
    const base = (column as unknown as { baseColumn: Column }).baseColumn;
    return value.map((v) =>
      base.columnType === "PgTimestamp" ? v : base.mapFromDriverValue(base.mapToDriverValue(v)),
    );
  }
  if (column.columnType === "PgTimestamp") return value;
  return column.mapFromDriverValue(column.mapToDriverValue(value));
}

function getColumnTsName(column: Column): string {
  return Object.entries(getTableColumns(column.table)).find(([, c]) => c.name === column.name)![0];
}

/** Whether the field's selection asks for `fieldName`, one level down. */
function selectionIncludesField(info: GraphQLResolveInfo, fieldName: string): boolean {
  for (const fieldNode of info.fieldNodes)
    for (const selection of fieldNode.selectionSet?.selections ?? [])
      if (selection.kind === "Field" && selection.name.value === fieldName) return true;
  return false;
}
