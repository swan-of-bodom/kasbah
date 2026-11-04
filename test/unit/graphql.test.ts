import { relations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  boolean,
  date,
  doublePrecision,
  bigint as int8,
  integer,
  jsonb,
  numeric,
  PgTable,
  pgTable,
  primaryKey,
  real,
  text,
} from "drizzle-orm/pg-core";
import { execute, type GraphQLType, parse } from "graphql";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import type { Tables } from "../../src/api/context.ts";
import {
  buildDataLoaderCache,
  buildGraphQLSchema,
  RequestBudget,
} from "../../src/api/graphql/schema.ts";
import { db, graphql } from "../../src/api/index.ts";
import { Api } from "../../src/api/server.ts";
import { bignum, hex } from "../../src/config/schema.ts";
import { createTableSql, tableInfo } from "../../src/db/table.ts";

const url = process.env.DATABASE_URL;
const pgSchema = "kasbah_test_graphql";
const it = test.skipIf(url === undefined);

type Result = { data?: any; errors?: { message: string }[] };

let api: Api | undefined;

afterEach(async () => {
  await api?.close();
  api = undefined;
});

afterAll(async () => {
  if (url === undefined) return;
  const owner = new pg.Client({ connectionString: url });
  await owner.connect();
  await owner.query(`DROP SCHEMA IF EXISTS ${pgSchema} CASCADE`);
  await owner.end();
});

const META = `('chain', '"SN_MAIN"'), ('checkpoint', '10'), ('checkpointTime', '20'), ('phase', '"live"')`;

/** A fresh schema with `tables`, filled by `seed` (SQL), and an API serving them at `/graphql`. */
async function setup(tables: Tables, seed = "") {
  const owner = new pg.Client({ connectionString: url, options: `-c search_path=${pgSchema}` });
  await owner.connect();
  try {
    await owner.query(`DROP SCHEMA IF EXISTS ${pgSchema} CASCADE; CREATE SCHEMA ${pgSchema}`);
    for (const t of Object.values(tables))
      if (t instanceof PgTable) await owner.query(createTableSql(tableInfo(t)));
    await owner.query(
      `CREATE TABLE _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL); INSERT INTO _kasbah_meta VALUES ${META}`,
    );
    if (seed !== "") await owner.query(seed);
  } finally {
    await owner.end();
  }
  const app = new Hono().use("/graphql", graphql({ db, schema: tables }));
  api = await Api.start({ database: url!, schema: pgSchema, tables, port: 0, app });
  const base = `http://127.0.0.1:${api.port}`;
  return async (query: string, variables?: Record<string, unknown>): Promise<Result> => {
    const response = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Result;
  };
}

it("_meta's status is GET /status: per chain, the last block committed", async () => {
  const query = await setup({});
  const result = await query(`query { _meta { status } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    _meta: { status: { SN_MAIN: { id: "SN_MAIN", block: { number: 10, timestamp: 20 } } } },
  });
});

it("scalar, not null, array and not null array columns read back with their GraphQL types", async () => {
  const schema = {
    table: pgTable("table", {
      id: text().primaryKey(),

      string: text(),
      int: integer(),
      float: doublePrecision(),
      boolean: boolean(),
      hex: hex(),
      bigint: bignum(),

      stringNotNull: text().notNull(),
      intNotNull: integer().notNull(),
      floatNotNull: doublePrecision().notNull(),
      booleanNotNull: boolean().notNull(),
      hexNotNull: hex().notNull(),
      bigintNotNull: bignum().notNull(),

      stringArray: text().array(),
      intArray: integer().array(),
      floatArray: doublePrecision().array(),
      booleanArray: boolean().array(),
      hexArray: hex().array(),
      bigintArray: bignum().array(),

      stringArrayNotNull: text().array().notNull(),
      intArrayNotNull: integer().array().notNull(),
      floatArrayNotNull: doublePrecision().array().notNull(),
      booleanArrayNotNull: boolean().array().notNull(),
      hexArrayNotNull: hex().array().notNull(),
      bigintArrayNotNull: bignum().array().notNull(),
    }),
  };
  const query = await setup(
    schema,
    `INSERT INTO "table" VALUES ('0', '0', 0, 0, false, '0x0', 0, '0', 0, 0, false, '0x0', 0,
      '{0}', '{0}', '{0}', '{false}', '{0x0}', '{0}', '{0}', '{0}', '{0}', '{false}', '{0x0}', '{0}')`,
  );

  const result = await query(`
    query {
      table(id: "0") {
        id
        string int float boolean hex bigint
        stringNotNull intNotNull floatNotNull booleanNotNull hexNotNull bigintNotNull
        stringArray intArray floatArray booleanArray hexArray bigintArray
        stringArrayNotNull intArrayNotNull floatArrayNotNull booleanArrayNotNull hexArrayNotNull bigintArrayNotNull
      }
    }
  `);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    table: {
      id: "0",

      string: "0",
      int: 0,
      float: 0,
      boolean: false,
      hex: "0x0",
      bigint: "0",

      stringNotNull: "0",
      intNotNull: 0,
      floatNotNull: 0,
      booleanNotNull: false,
      hexNotNull: "0x0",
      bigintNotNull: "0",

      stringArray: ["0"],
      intArray: [0],
      floatArray: [0],
      booleanArray: [false],
      hexArray: ["0x0"],
      bigintArray: ["0"],

      stringArrayNotNull: ["0"],
      intArrayNotNull: [0],
      floatArrayNotNull: [0],
      booleanArrayNotNull: [false],
      hexArrayNotNull: ["0x0"],
      bigintArrayNotNull: ["0"],
    },
  });
});

it("json columns read back as JSON", async () => {
  const schema = {
    table: pgTable("table", {
      id: text().primaryKey(),
      json: jsonb(),
      jsonNotNull: jsonb().notNull(),
    }),
  };
  const query = await setup(schema, `INSERT INTO "table" VALUES ('0', NULL, '{"kevin": 52}')`);

  const result = await query(`query { table(id: "0") { id json jsonNotNull } }`);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    table: { id: "0", json: null, jsonNotNull: { kevin: 52 } },
  });
});

it("the singular field finds a row by its primary key, composite keys too", async () => {
  const transferEvents = pgTable("transfer_events", {
    id: text().primaryKey(),
    amount: bignum().notNull(),
  });
  const allowances = pgTable(
    "allowances",
    { owner: text().notNull(), spender: text().notNull(), amount: bignum().notNull() },
    (t) => [primaryKey({ columns: [t.owner, t.spender] })],
  );
  const query = await setup(
    { transferEvents, allowances },
    `INSERT INTO transfer_events VALUES ('0', 0), ('1', 10);
     INSERT INTO allowances VALUES ('0', '0', 1), ('0', '1', 10), ('1', '0', 100)`,
  );

  let result = await query(`query { transferEvents(id: "0") { id amount } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ transferEvents: { id: "0", amount: "0" } });

  result = await query(`query { transferEvents(id: "1") { id amount } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ transferEvents: { id: "1", amount: "10" } });

  result = await query(`query { allowances(owner: "0", spender: "0") { owner spender amount } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ allowances: { owner: "0", spender: "0", amount: "1" } });

  result = await query(`query { allowances(owner: "1", spender: "0") { owner spender amount } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    allowances: { owner: "1", spender: "0", amount: "100" },
  });

  result = await query(`query { transferEvents(id: "2") { id } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toEqual({ transferEvents: null });
});

it("a one relation is the related row, or null when its columns match none", async () => {
  const person = pgTable("person", { id: text().primaryKey(), name: text() });
  const pet = pgTable("pet", {
    id: text().primaryKey(),
    ownerId: text().notNull(),
    ownerIdNullable: text(),
  });
  // Nullable whether or not the `fields` columns are.
  const petRelations = relations(pet, ({ one }) => ({
    owner: one(person, { fields: [pet.ownerId], references: [person.id] }),
    ownerNullable: one(person, { fields: [pet.ownerIdNullable], references: [person.id] }),
  }));
  const query = await setup(
    { person, pet, petRelations },
    `INSERT INTO person VALUES ('jake', 'jake'), ('kyle', 'kyle');
     INSERT INTO pet (id, "ownerId") VALUES ('dog1', 'jake')`,
  );

  const result = await query(`
    query { pet(id: "dog1") { owner { id name } ownerNullable { id } } }
  `);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    pet: { owner: { id: "jake", name: "jake" }, ownerNullable: null },
  });
});

it("a one relation works with a camel case references column", async () => {
  const person = pgTable("person", { camelCaseId: text().primaryKey(), name: text() });
  const pet = pgTable("pet", { id: text().primaryKey(), ownerId: text() });
  const petRelations = relations(pet, ({ one }) => ({
    owner: one(person, { fields: [pet.ownerId], references: [person.camelCaseId] }),
  }));
  const query = await setup(
    { person, pet, petRelations },
    `INSERT INTO person VALUES ('jake', 'jake');
     INSERT INTO pet VALUES ('dog1', 'jake'), ('dog2', 'kyle')`,
  );

  const result = await query(`query { pet(id: "dog1") { owner { camelCaseId } } }`);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ pet: { owner: { camelCaseId: "jake" } } });
});

const people = () => {
  const person = pgTable("person", { id: text().primaryKey(), name: text() });
  const pet = pgTable("pet", { id: text().primaryKey(), age: integer(), ownerId: text() });
  const personRelations = relations(person, ({ many }) => ({ pets: many(pet) }));
  const petRelations = relations(pet, ({ one }) => ({
    owner: one(person, { fields: [pet.ownerId], references: [person.id] }),
  }));
  return { person, personRelations, pet, petRelations };
};

it("a many relation is a page of the rows whose one relation points back", async () => {
  const query = await setup(
    people(),
    `INSERT INTO person VALUES ('jake', 'jake');
     INSERT INTO pet (id, "ownerId") VALUES ('dog1', 'jake'), ('dog2', 'jake'), ('dog3', 'kyle')`,
  );

  const result = await query(`query { person(id: "jake") { pets { items { id } } } }`);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    person: { pets: { items: [{ id: "dog1" }, { id: "dog2" }] } },
  });
});

it("a many relation works with a camel case references column", async () => {
  const person = pgTable("person", { camelCaseId: text().primaryKey(), name: text() });
  const pet = pgTable("pet", { id: text().primaryKey(), ownerId: text() });
  const personRelations = relations(person, ({ many }) => ({ pets: many(pet) }));
  const petRelations = relations(pet, ({ one }) => ({
    owner: one(person, { fields: [pet.ownerId], references: [person.camelCaseId] }),
  }));
  const query = await setup(
    { person, personRelations, pet, petRelations },
    `INSERT INTO person VALUES ('jake', 'jake');
     INSERT INTO pet VALUES ('dog1', 'jake'), ('dog2', 'jake'), ('dog3', 'kyle')`,
  );

  const result = await query(`query { person(camelCaseId: "jake") { pets { items { id } } } }`);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    person: { pets: { items: [{ id: "dog1" }, { id: "dog2" }] } },
  });
});

it("a many relation finds its one relation among others on the related table", async () => {
  const extra = pgTable("extra", { id: text().primaryKey(), name: text() });
  const user = pgTable("user", { id: text().primaryKey(), name: text() });
  const hero = pgTable("hero", { id: text().primaryKey(), ownerId: text(), extraId: text() });
  const userRelations = relations(user, ({ many }) => ({ heroes: many(hero) }));
  const heroRelations = relations(hero, ({ one }) => ({
    extra: one(extra, { fields: [hero.extraId], references: [extra.id] }),
    owner: one(user, { fields: [hero.ownerId], references: [user.id] }),
  }));
  const extraRelations = relations(extra, ({ one }) => ({
    cuh: one(user, { fields: [extra.id], references: [user.id] }),
  }));
  const query = await setup(
    { extra, extraRelations, hero, heroRelations, user, userRelations },
    `INSERT INTO "user" VALUES ('jake', 'jake');
     INSERT INTO hero (id, "ownerId") VALUES ('dog1', 'jake'), ('dog2', 'jake'), ('dog3', 'kyle')`,
  );

  const result = await query(`query { user(id: "jake") { heroes { items { id } } } }`);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    user: { heroes: { items: [{ id: "dog1" }, { id: "dog2" }] } },
  });
});

it("two many relations to one table each follow the one relation of their name", async () => {
  const person = pgTable("person", { id: text().primaryKey(), name: text() });
  const pet = pgTable("pet", { id: text().primaryKey(), owner1: text(), owner2: text() });
  const personRelations = relations(person, ({ many }) => ({
    pets1: many(pet, { relationName: "owner1_relation" }),
    pets2: many(pet, { relationName: "owner2_relation" }),
  }));
  const petRelations = relations(pet, ({ one }) => ({
    owner1Relation: one(person, {
      fields: [pet.owner1],
      relationName: "owner1_relation",
      references: [person.id],
    }),
    owner2Relation: one(person, {
      fields: [pet.owner2],
      relationName: "owner2_relation",
      references: [person.id],
    }),
  }));
  const query = await setup(
    { person, personRelations, pet, petRelations },
    `INSERT INTO person VALUES ('jake', 'jake');
     INSERT INTO pet VALUES ('dog1', 'jake', 'jim'), ('dog2', 'jake', 'kyle'), ('dog3', 'kyle', 'jim')`,
  );

  const result = await query(`
    query { person(id: "jake") { pets1 { items { id } } pets2 { items { id } } } }
  `);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toEqual({
    person: { pets1: { items: [{ id: "dog1" }, { id: "dog2" }] }, pets2: { items: [] } },
  });
});

it("a many relation takes a filter and counts what matches", async () => {
  const query = await setup(
    people(),
    `INSERT INTO person VALUES ('jake', 'jake');
     INSERT INTO pet VALUES ('dog1', 1, 'jake'), ('dog2', 2, 'jake'), ('dog3', 3, 'jake')`,
  );

  const result = await query(`
    query { person(id: "jake") { pets(where: { id: "dog2" }) { items { id } totalCount } } }
  `);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    person: { pets: { items: [{ id: "dog2" }], totalCount: 1 } },
  });
});

it("a many relation takes an order", async () => {
  const query = await setup(
    people(),
    `INSERT INTO person VALUES ('jake', 'jake');
     INSERT INTO pet VALUES ('dog1', 1, 'jake'), ('dog2', 2, 'jake'), ('dog3', 3, 'jake')`,
  );

  const result = await query(`
    query { person(id: "jake") { pets(orderBy: "age", orderDirection: "desc") { items { id } } } }
  `);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    person: { pets: { items: [{ id: "dog3" }, { id: "dog2" }, { id: "dog1" }] } },
  });
});

it("a page's one relations are loaded in one statement", async () => {
  // Before the API starts: its pool binds the method when it is made.
  const spy = vi.spyOn(pg.Pool.prototype, "query");
  try {
    const query = await setup(
      people(),
      `INSERT INTO person VALUES ('jake', 'jake');
       INSERT INTO pet (id, "ownerId") VALUES ('dog1', 'jake'), ('dog2', 'jake'), ('dog3', 'kyle')`,
    );

    const result = await query(`query { pets { items { id owner { id } } } }`);

    expect(result.errors?.[0]?.message).toBeUndefined();
    expect(result.data).toMatchObject({
      pets: {
        items: [
          { id: "dog1", owner: { id: "jake" } },
          { id: "dog2", owner: { id: "jake" } },
          { id: "dog3", owner: null },
        ],
      },
    });
    const texts = spy.mock.calls.map(([q]) =>
      typeof q === "string" ? q : (q as { text: string }).text,
    );
    expect(texts.filter((t) => t.includes(`from "person"`))).toHaveLength(1);
    expect(texts.filter((t) => t.includes(`from "pet"`))).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});

it("each column type has its filters", () => {
  const table = pgTable("table", {
    text: text().primaryKey(),
    hex: hex(),
    bool: boolean(),

    int: integer(),
    int8Number: int8({ mode: "number" }),
    int8Bigint: int8({ mode: "bigint" }),
    real: real(),
    doublePrecision: doublePrecision(),

    numeric: numeric(),
    numericArray: numeric().array(),

    bigint: bignum(),
    bigintArray: bignum().array(),

    json: jsonb(),
  });
  const typeMap = buildGraphQLSchema({ schema: { table } }).getTypeMap();
  const fields = (typeMap.tableFilter!.toConfig() as any).fields as Record<
    string,
    { type: GraphQLType }
  >;
  const fieldsPretty = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, value.type.toString()]),
  );

  expect(fieldsPretty).toEqual({
    AND: "[tableFilter]",
    OR: "[tableFilter]",

    text: "String",
    text_not: "String",
    text_in: "[String]",
    text_not_in: "[String]",
    text_contains: "String",
    text_not_contains: "String",
    text_starts_with: "String",
    text_ends_with: "String",
    text_not_starts_with: "String",
    text_not_ends_with: "String",
    text_contains_nocase: "String",
    text_not_contains_nocase: "String",
    text_starts_with_nocase: "String",
    text_ends_with_nocase: "String",
    text_not_starts_with_nocase: "String",
    text_not_ends_with_nocase: "String",

    hex: "String",
    hex_not: "String",
    hex_in: "[String]",
    hex_not_in: "[String]",
    hex_contains: "String",
    hex_not_contains: "String",
    hex_starts_with: "String",
    hex_ends_with: "String",
    hex_not_starts_with: "String",
    hex_not_ends_with: "String",

    bool: "Boolean",
    bool_not: "Boolean",
    bool_in: "[Boolean]",
    bool_not_in: "[Boolean]",

    int: "Int",
    int_not: "Int",
    int_in: "[Int]",
    int_not_in: "[Int]",
    int_gt: "Int",
    int_lt: "Int",
    int_gte: "Int",
    int_lte: "Int",

    int8Number: "Int",
    int8Number_not: "Int",
    int8Number_in: "[Int]",
    int8Number_not_in: "[Int]",
    int8Number_gt: "Int",
    int8Number_lt: "Int",
    int8Number_gte: "Int",
    int8Number_lte: "Int",

    int8Bigint: "BigInt",
    int8Bigint_not: "BigInt",
    int8Bigint_in: "[BigInt]",
    int8Bigint_not_in: "[BigInt]",
    int8Bigint_gt: "BigInt",
    int8Bigint_lt: "BigInt",
    int8Bigint_gte: "BigInt",
    int8Bigint_lte: "BigInt",

    real: "Float",
    real_not: "Float",
    real_in: "[Float]",
    real_not_in: "[Float]",
    real_gt: "Float",
    real_lt: "Float",
    real_gte: "Float",
    real_lte: "Float",

    doublePrecision: "Float",
    doublePrecision_not: "Float",
    doublePrecision_in: "[Float]",
    doublePrecision_not_in: "[Float]",
    doublePrecision_gt: "Float",
    doublePrecision_lt: "Float",
    doublePrecision_gte: "Float",
    doublePrecision_lte: "Float",

    numeric: "Numeric",
    numeric_not: "Numeric",
    numeric_in: "[Numeric]",
    numeric_not_in: "[Numeric]",
    numeric_gt: "Numeric",
    numeric_lt: "Numeric",
    numeric_gte: "Numeric",
    numeric_lte: "Numeric",

    numericArray: "[Numeric]",
    numericArray_not: "[Numeric]",
    numericArray_has: "Numeric",
    numericArray_not_has: "Numeric",

    bigint: "BigInt",
    bigint_not: "BigInt",
    bigint_in: "[BigInt]",
    bigint_not_in: "[BigInt]",
    bigint_gt: "BigInt",
    bigint_lt: "BigInt",
    bigint_gte: "BigInt",
    bigint_lte: "BigInt",

    bigintArray: "[BigInt]",
    bigintArray_not: "[BigInt]",
    bigintArray_has: "BigInt",
    bigintArray_not_has: "BigInt",
  });
});

const ids = (result: Result, field: string) =>
  result.data?.[field]?.items.map((i: { id: string }) => i.id);

it("filters on equality and inequality", async () => {
  const person = pgTable("person", { id: bignum().primaryKey() });
  const query = await setup({ person }, `INSERT INTO person VALUES (1), (2), (3)`);

  let result = await query(`query { persons(where: { id: "1" }) { items { id } } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ persons: { items: [{ id: "1" }] } });

  result = await query(`query { persons(where: { id_not: "1" }) { items { id } } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ persons: { items: [{ id: "2" }, { id: "3" }] } });
});

it("a filter on null is IS NULL, and its _not IS NOT NULL", async () => {
  const person = pgTable("person", { id: bignum().primaryKey(), nullable: text() });
  const query = await setup({ person }, `INSERT INTO person VALUES (1, 'a'), (2, 'b'), (3, NULL)`);

  let result = await query(
    `query { persons(where: { nullable: null }) { items { id nullable } } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ persons: { items: [{ id: "3", nullable: null }] } });

  result = await query(
    `query { persons(where: { nullable_not: null }) { items { id nullable } } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    persons: {
      items: [
        { id: "1", nullable: "a" },
        { id: "2", nullable: "b" },
      ],
    },
  });
});

it("filters on membership in a list", async () => {
  const person = pgTable("person", { id: hex().primaryKey() });
  const query = await setup({ person }, `INSERT INTO person VALUES ('0x01'), ('0x02'), ('0x03')`);

  let result = await query(
    `query { persons(where: { id_in: ["0x01", "0x02"] }) { items { id } } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ persons: { items: [{ id: "0x01" }, { id: "0x02" }] } });

  result = await query(
    `query { persons(where: { id_not_in: ["0x01", "0x02"] }) { items { id } } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ persons: { items: [{ id: "0x03" }] } });
});

it("filters on array columns: equal, not equal, has and not has", async () => {
  const person = pgTable("person", {
    id: text().primaryKey(),
    number: integer().array().notNull(),
  });
  const query = await setup(
    { person },
    `INSERT INTO person VALUES ('1', '{1,2,3}'), ('2', '{3,4,5}'), ('3', '{5,6,7}')`,
  );

  let result = await query(
    `query { persons(where: { number: [1, 2, 3] }) { items { id number } } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ persons: { items: [{ id: "1", number: [1, 2, 3] }] } });

  result = await query(`query { persons(where: { number_not: [5] }) { items { id number } } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    persons: {
      items: [
        { id: "1", number: [1, 2, 3] },
        { id: "2", number: [3, 4, 5] },
        { id: "3", number: [5, 6, 7] },
      ],
    },
  });

  result = await query(`query { persons(where: { number_has: 3 }) { items { id number } } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    persons: {
      items: [
        { id: "1", number: [1, 2, 3] },
        { id: "2", number: [3, 4, 5] },
      ],
    },
  });

  result = await query(`query { persons(where: { number_not_has: 4 }) { items { id number } } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    persons: {
      items: [
        { id: "1", number: [1, 2, 3] },
        { id: "3", number: [5, 6, 7] },
      ],
    },
  });
});

it("filters on numbers of every type compare them", async () => {
  const person = pgTable("person", {
    id: text().primaryKey(),
    number: integer(),
    bigintNumber: int8({ mode: "number" }),
    bigintBigint: int8({ mode: "bigint" }),
    float: doublePrecision(),
    bigint: bignum(),
    numeric: numeric(),
  });
  const query = await setup(
    { person },
    `INSERT INTO person VALUES ('1', 1, 1, 1, 1.5, 1, '1'), ('2', 2, 2, 2, 2.5, 2, '2'), ('3', 3, 3, 3, 3.5, 3, '3')`,
  );

  const cases: [string, string[]][] = [
    [`{ number_gt: 1 }`, ["2", "3"]],
    [`{ bigintNumber_lte: 1 }`, ["1"]],
    [`{ bigintBigint_lte: "1" }`, ["1"]],
    [`{ float_lt: 3.5 }`, ["1", "2"]],
    [`{ bigint_gte: "2" }`, ["2", "3"]],
    [`{ numeric_gte: "2.1" }`, ["3"]],
  ];
  for (const [where, expected] of cases) {
    const result = await query(`query { persons(where: ${where}) { items { id } } }`);
    expect(result.errors?.[0]?.message).toBeUndefined();
    expect(ids(result, "persons")).toEqual(expected);
  }
});

it("filters on strings match prefixes, suffixes and substrings, with or without case", async () => {
  const person = pgTable("person", { id: text().primaryKey(), text: text(), hex: hex() });
  const query = await setup(
    { person },
    `INSERT INTO person VALUES ('1', 'one', '0xabc'), ('2', 'two', '0xcde'), ('3', 'three', '0xef0')`,
  );

  const cases: [string, string[]][] = [
    [`{ text_starts_with: "o" }`, ["1"]],
    [`{ text_starts_with_nocase: "O" }`, ["1"]],
    [`{ text_not_ends_with: "e" }`, ["2"]],
    [`{ text_not_ends_with_nocase: "E" }`, ["2"]],
    [`{ hex_contains: "c" }`, ["1", "2"]],
  ];
  for (const [where, expected] of cases) {
    const result = await query(`query { persons(where: ${where}) { items { id } } }`);
    expect(result.errors?.[0]?.message).toBeUndefined();
    expect(ids(result, "persons")).toEqual(expected);
  }
});

const petsTable = () =>
  pgTable("pet", {
    id: text().primaryKey(),
    name: text().notNull(),
    bigAge: bignum(),
    age: integer(),
  });

const PETS = `INSERT INTO pet VALUES ('id1', 'Skip', 105, NULL), ('id2', 'Foo', 10, NULL), ('id3', 'Bar', 190, NULL),
  ('id4', 'Zarbar', NULL, NULL), ('id5', 'Winston', NULL, 12)`;

it("filters combine with AND and OR, nested", async () => {
  const query = await setup({ pet: petsTable() }, PETS);

  const result = await query(`
    query {
      pets(where: { OR: [{ bigAge_gt: "50" }, { AND: [{ name: "Foo" }, { bigAge_lt: "20" }] }] }) {
        items { id name bigAge }
      }
    }
  `);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data.pets.items).toMatchObject([
    { id: "id1", name: "Skip", bigAge: "105" },
    { id: "id2", name: "Foo", bigAge: "10" },
    { id: "id3", name: "Bar", bigAge: "190" },
  ]);
});

it("orderBy sorts by a column of any type, in either direction", async () => {
  const person = pgTable("person", {
    id: text().primaryKey(),
    integer: integer(),
    bigintBigint: int8({ mode: "bigint" }),
    float: doublePrecision(),
    bigint: bignum(),
    hex: hex(),
  });
  const query = await setup(
    { person },
    `INSERT INTO person VALUES ('1', 1, 1, 1.5, 1, '0xa'), ('2', 2, 2, 2.5, 3, '0xc'), ('3', 3, 3, 3.5, 2, '0xb')`,
  );

  const cases: [string, string[]][] = [
    ["integer", ["3", "2", "1"]],
    ["bigintBigint", ["3", "2", "1"]],
    ["float", ["3", "2", "1"]],
    ["bigint", ["2", "3", "1"]],
    ["hex", ["2", "3", "1"]],
  ];
  for (const [column, expected] of cases) {
    const result = await query(
      `query { persons(orderBy: "${column}", orderDirection: "desc") { items { id } } }`,
    );
    expect(result.errors?.[0]?.message).toBeUndefined();
    expect(ids(result, "persons")).toEqual(expected);
  }
});

it("a page has 50 rows by default and at most 1000", async () => {
  const person = pgTable("person", { id: text().primaryKey() });
  const query = await setup(
    { person },
    `INSERT INTO person SELECT i::text FROM generate_series(0, 99) i`,
  );

  let result = await query(`query { persons { items { id } } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data.persons.items).toHaveLength(50);

  result = await query(`query { persons(limit: 75) { items { id } } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data.persons.items).toHaveLength(75);

  result = await query(`query { persons(limit: 1005) { items { id } } }`);
  expect(result.errors?.[0]?.message).toBe("Invalid limit. Got 1005, expected <=1000.");
});

const PAGE = `items { id name } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } totalCount`;
const anyCursors = (hasPreviousPage: boolean, hasNextPage: boolean) => ({
  hasNextPage,
  hasPreviousPage,
  startCursor: expect.any(String),
  endCursor: expect.any(String),
});

it("cursors page forward and back in ascending order", async () => {
  const pet = pgTable("pet", { id: text().primaryKey(), name: text().notNull() });
  const query = await setup(
    { pet },
    `INSERT INTO pet VALUES ('id1', 'Skip'), ('id2', 'Foo'), ('id3', 'Bar'), ('id4', 'Zarbar'), ('id5', 'Winston'),
      ('id6', 'Book'), ('id7', 'Shea'), ('id8', 'Snack'), ('id9', 'Last')`,
  );

  let result = await query(
    `query { pets(orderBy: "id", orderDirection: "asc", limit: 5) { ${PAGE} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    pets: {
      items: [
        { id: "id1", name: "Skip" },
        { id: "id2", name: "Foo" },
        { id: "id3", name: "Bar" },
        { id: "id4", name: "Zarbar" },
        { id: "id5", name: "Winston" },
      ],
      pageInfo: anyCursors(false, true),
      totalCount: 9,
    },
  });

  const endCursor = result.data.pets.pageInfo.endCursor;
  result = await query(
    `query { pets(orderBy: "id", orderDirection: "asc", after: "${endCursor}") { ${PAGE} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    pets: {
      items: [
        { id: "id6", name: "Book" },
        { id: "id7", name: "Shea" },
        { id: "id8", name: "Snack" },
        { id: "id9", name: "Last" },
      ],
      pageInfo: anyCursors(true, false),
      totalCount: 9,
    },
  });

  const startCursor = result.data.pets.pageInfo.startCursor;
  result = await query(
    `query { pets(orderBy: "id", orderDirection: "asc", before: "${startCursor}", limit: 2) { ${PAGE} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    pets: {
      items: [
        { id: "id4", name: "Zarbar" },
        { id: "id5", name: "Winston" },
      ],
      pageInfo: anyCursors(true, true),
      totalCount: 9,
    },
  });
});

it("cursors page forward and back in descending order", async () => {
  const query = await setup({ pet: petsTable() }, PETS);

  let result = await query(
    `query { pets(orderBy: "name", orderDirection: "desc", limit: 2) { ${PAGE} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    pets: {
      items: [
        { id: "id4", name: "Zarbar" },
        { id: "id5", name: "Winston" },
      ],
      pageInfo: anyCursors(false, true),
      totalCount: 5,
    },
  });

  const endCursor = result.data.pets.pageInfo.endCursor;
  result = await query(
    `query { pets(orderBy: "name", orderDirection: "desc", after: "${endCursor}") { ${PAGE} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    pets: {
      items: [
        { id: "id1", name: "Skip" },
        { id: "id2", name: "Foo" },
        { id: "id3", name: "Bar" },
      ],
      pageInfo: anyCursors(true, false),
      totalCount: 5,
    },
  });

  const startCursor = result.data.pets.pageInfo.startCursor;
  result = await query(
    `query { pets(orderBy: "name", orderDirection: "desc", before: "${startCursor}", limit: 1) { ${PAGE} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    pets: {
      items: [{ id: "id5", name: "Winston" }],
      pageInfo: anyCursors(true, true),
      totalCount: 5,
    },
  });
});

it("a page with every row has both cursors and no page on either side", async () => {
  const query = await setup({ pet: petsTable() }, PETS);

  const result = await query(`query { pets(orderBy: "name", orderDirection: "asc") { ${PAGE} } }`);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    pets: {
      items: [
        { id: "id3", name: "Bar" },
        { id: "id2", name: "Foo" },
        { id: "id1", name: "Skip" },
        { id: "id5", name: "Winston" },
        { id: "id4", name: "Zarbar" },
      ],
      pageInfo: anyCursors(false, false),
      totalCount: 5,
    },
  });
});

it("an empty page after the last row still has a previous page", async () => {
  const query = await setup({ pet: petsTable() }, PETS);

  let result = await query(`query { pets(orderBy: "name", orderDirection: "asc") { ${PAGE} } }`);
  expect(result.errors?.[0]?.message).toBeUndefined();

  const endCursor = result.data.pets.pageInfo.endCursor;
  result = await query(
    `query { pets(orderBy: "name", orderDirection: "asc", after: "${endCursor}") { ${PAGE} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    pets: {
      items: [],
      pageInfo: { startCursor: null, endCursor: null, hasPreviousPage: true, hasNextPage: false },
      totalCount: 5,
    },
  });
});

it("cursors page through a composite primary key", async () => {
  const allowance = pgTable(
    "allowance",
    { owner: text().notNull(), spender: text("speeeeender").notNull(), amount: bignum().notNull() },
    (t) => [primaryKey({ columns: [t.owner, t.spender] })],
  );
  const query = await setup(
    { allowance },
    `INSERT INTO allowance VALUES ('alice', 'bob', 100), ('bob', 'alice', 400), ('bob', 'bill', 500),
      ('bill', 'bill', 600), ('bill', 'jenny', 700), ('jenny', 'bill', 800)`,
  );
  const page = `items { owner spender amount } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } totalCount`;

  let result = await query(
    `query { allowances(orderBy: "owner", orderDirection: "asc", limit: 4) { ${page} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    allowances: {
      items: [
        { owner: "alice", spender: "bob", amount: "100" },
        { owner: "bill", spender: "bill", amount: "600" },
        { owner: "bill", spender: "jenny", amount: "700" },
        { owner: "bob", spender: "alice", amount: "400" },
      ],
      pageInfo: anyCursors(false, true),
      totalCount: 6,
    },
  });

  const endCursor = result.data.allowances.pageInfo.endCursor;
  result = await query(
    `query { allowances(orderBy: "owner", orderDirection: "asc", after: "${endCursor}") { ${page} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    allowances: {
      items: [
        { owner: "bob", spender: "bill", amount: "500" },
        { owner: "jenny", spender: "bill", amount: "800" },
      ],
      pageInfo: anyCursors(true, false),
      totalCount: 6,
    },
  });

  const startCursor = result.data.allowances.pageInfo.startCursor;
  result = await query(
    `query { allowances(orderBy: "owner", orderDirection: "asc", before: "${startCursor}", limit: 2) { ${page} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({
    allowances: {
      items: [
        { owner: "bill", spender: "jenny", amount: "700" },
        { owner: "bob", spender: "alice", amount: "400" },
      ],
      pageInfo: anyCursors(true, true),
      totalCount: 6,
    },
  });
});

it("cursors page through a date column, and keep its type", async () => {
  const pet = pgTable("pet", {
    id: text().primaryKey(),
    name: text().notNull(),
    createdAt: date({ mode: "date" }).notNull(),
  });
  const query = await setup(
    { pet },
    `INSERT INTO pet VALUES ('id1', 'Skip', '2021-01-01'), ('id2', 'Foo', '2021-01-02'), ('id3', 'Bar', '2021-01-03'),
      ('id4', 'Zarbar', '2021-01-04'), ('id5', 'Winston', '2021-01-05'), ('id6', 'Book', '2021-01-06'),
      ('id7', 'Shea', '2021-01-07'), ('id8', 'Snack', '2021-01-08'), ('id9', 'Last', '2021-01-09')`,
  );
  const page = `items { id name createdAt } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } totalCount`;

  let result = await query(
    `query { pets(orderBy: "createdAt", orderDirection: "asc", limit: 5) { ${page} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchInlineSnapshot(`
    {
      "pets": {
        "items": [
          {
            "createdAt": "1609459200000",
            "id": "id1",
            "name": "Skip",
          },
          {
            "createdAt": "1609545600000",
            "id": "id2",
            "name": "Foo",
          },
          {
            "createdAt": "1609632000000",
            "id": "id3",
            "name": "Bar",
          },
          {
            "createdAt": "1609718400000",
            "id": "id4",
            "name": "Zarbar",
          },
          {
            "createdAt": "1609804800000",
            "id": "id5",
            "name": "Winston",
          },
        ],
        "pageInfo": {
          "endCursor": "eyJqc29uIjp7ImNyZWF0ZWRBdCI6IjIwMjEtMDEtMDVUMDA6MDA6MDAuMDAwWiIsImlkIjoiaWQ1In0sIm1ldGEiOnsidmFsdWVzIjp7ImNyZWF0ZWRBdCI6WyJEYXRlIl19LCJ2IjoxfX0=",
          "hasNextPage": true,
          "hasPreviousPage": false,
          "startCursor": "eyJqc29uIjp7ImNyZWF0ZWRBdCI6IjIwMjEtMDEtMDFUMDA6MDA6MDAuMDAwWiIsImlkIjoiaWQxIn0sIm1ldGEiOnsidmFsdWVzIjp7ImNyZWF0ZWRBdCI6WyJEYXRlIl19LCJ2IjoxfX0=",
        },
        "totalCount": 9,
      },
    }
  `);

  const endCursor = result.data.pets.pageInfo.endCursor;
  result = await query(
    `query { pets(orderBy: "createdAt", orderDirection: "asc", after: "${endCursor}") { ${page} } }`,
  );
  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchInlineSnapshot(`
    {
      "pets": {
        "items": [
          {
            "createdAt": "1609891200000",
            "id": "id6",
            "name": "Book",
          },
          {
            "createdAt": "1609977600000",
            "id": "id7",
            "name": "Shea",
          },
          {
            "createdAt": "1610064000000",
            "id": "id8",
            "name": "Snack",
          },
          {
            "createdAt": "1610150400000",
            "id": "id9",
            "name": "Last",
          },
        ],
        "pageInfo": {
          "endCursor": "eyJqc29uIjp7ImNyZWF0ZWRBdCI6IjIwMjEtMDEtMDlUMDA6MDA6MDAuMDAwWiIsImlkIjoiaWQ5In0sIm1ldGEiOnsidmFsdWVzIjp7ImNyZWF0ZWRBdCI6WyJEYXRlIl19LCJ2IjoxfX0=",
          "hasNextPage": false,
          "hasPreviousPage": true,
          "startCursor": "eyJqc29uIjp7ImNyZWF0ZWRBdCI6IjIwMjEtMDEtMDZUMDA6MDA6MDAuMDAwWiIsImlkIjoiaWQ2In0sIm1ldGEiOnsidmFsdWVzIjp7ImNyZWF0ZWRBdCI6WyJEYXRlIl19LCJ2IjoxfX0=",
        },
        "totalCount": 9,
      },
    }
  `);
});

it.each(["asc", "desc"])(
  "paging %s by a column with ties visits every row once",
  async (direction) => {
    const pool = pgTable("pool", { id: text().primaryKey(), swaps: integer().notNull() });
    const rows = Array.from({ length: 17 }, (_, i) => ({
      id: `p${String(i).padStart(2, "0")}`,
      swaps: (i * 7) % 5,
    }));
    const query = await setup(
      { pool },
      `INSERT INTO pool VALUES ${rows.map((r) => `('${r.id}', ${r.swaps})`).join(", ")}`,
    );

    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const result: Result = await query(
        `query ($after: String) { pools(orderBy: "swaps", orderDirection: "${direction}", limit: 3, after: $after) { items { id } pageInfo { hasNextPage endCursor } } }`,
        { after },
      );
      expect(result.errors?.[0]?.message).toBeUndefined();
      seen.push(...ids(result, "pools"));
      if (!result.data.pools.pageInfo.hasNextPage) break;
      after = result.data.pools.pageInfo.endCursor;
    }
    const sign = direction === "asc" ? 1 : -1;
    const expected = [...rows]
      .sort((a, b) => sign * (a.swaps - b.swaps || a.id.localeCompare(b.id)))
      .map((r) => r.id);
    expect(seen).toEqual(expected);
  },
);

it("fields are the table object's keys, whatever the database calls the columns", async () => {
  const schema = {
    table: pgTable("table", {
      id: text().primaryKey(),
      userName: text("user_name"),
      camelCase: text(),
    }),
  };
  const query = await setup(schema, `INSERT INTO "table" VALUES ('0', '0', '0')`);

  const result = await query(`query { table(id: "0") { id userName camelCase } }`);

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ table: { id: "0", userName: "0", camelCase: "0" } });
});

it("snake case table and column names work in the singular field's arguments", async () => {
  const schema = {
    deposited_token: pgTable(
      "deposited_token",
      {
        chain_id: bignum().notNull(),
        token_address: hex().notNull(),
        first_seen_at: bignum().notNull(),
        total_supply: bignum().notNull(),
      },
      (t) => [primaryKey({ columns: [t.token_address, t.chain_id] })],
    ),
  };
  const zero = `0x${"0".repeat(64)}`;
  const query = await setup(schema, `INSERT INTO deposited_token VALUES (1, '${zero}', 0, 0)`);

  const result = await query(
    `query { deposited_token(token_address: "${zero}", chain_id: "1") { chain_id } }`,
  );

  expect(result.errors?.[0]?.message).toBeUndefined();
  expect(result.data).toMatchObject({ deposited_token: { chain_id: "1" } });
});

it("GET opens GraphiQL", async () => {
  await setup({});
  const page = await fetch(`http://127.0.0.1:${api!.port}/graphql`);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("GraphiQL.createFetcher");
});

it("mistakes in a query are GraphQL errors with their reason, never a 500", async () => {
  const person = pgTable("person", { id: text().primaryKey(), amount: bignum(), price: numeric() });
  const query = await setup({ person }, `INSERT INTO person VALUES ('1', 1, '1')`);

  const message = async (q: string) => (await query(q)).errors?.[0]?.message;
  expect(await message(`{ persons(after: "garbage") { items { id } } }`)).toBe("Invalid cursor");
  expect(await message(`{ persons(orderBy: "nope") { items { id } } }`)).toBe(
    'Unknown column "nope" used in orderBy argument',
  );
  expect(await message(`{ persons(after: "x", before: "y") { items { id } } }`)).toBe(
    "Cannot specify both before and after cursors.",
  );
  expect(await message(`{ persons(where: { amount: "1.5" }) { items { id } } }`)).toMatch(
    /Cannot convert 1\.5 to a BigInt/,
  );
  expect(await message(`{ persons(where: { amount: 1 }) { items { id } } }`)).toMatch(
    /Expected: StringValue/,
  );
  expect(await message(`{ persons(where: { price_gt: "abc" }) { items { id } } }`)).toMatch(
    /invalid input syntax for type numeric/,
  );
  expect(await message(`{ persons(offset: -1) { items { id } } }`)).toMatch(
    /OFFSET must not be negative/,
  );
  expect(await message(`{ nothing }`)).toMatch(/Cannot query field/);
  expect(
    await message(
      `{ ${Array.from({ length: 501 }, (_, i) => `a${i}: person(id: "1") { id }`).join(" ")} }`,
    ),
  ).toMatch(/Token limit of 1000 exceeded/);
});

it("in production, a mistake in the query still reaches the client with its message", async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let query: Awaited<ReturnType<typeof setup>>;
  try {
    query = await setup({ person: pgTable("person", { id: text().primaryKey() }) });
  } finally {
    process.env.NODE_ENV = before;
  }
  expect((await query(`{ persons(limit: 2000) { items { id } } }`)).errors?.[0]?.message).toBe(
    "Invalid limit. Got 2000, expected <=1000.",
  );
});

it("a request that would read more rows than its share of the heap is refused", async () => {
  const tables = people();
  await setup(
    tables,
    `INSERT INTO person SELECT 'p' || i, repeat('x', 100) FROM generate_series(1, 50) i;
     INSERT INTO pet SELECT 'd' || i, i, 'p' || (i % 50 + 1) FROM generate_series(1, 1000) i`,
  );
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${pgSchema}` });
  try {
    const run = (maxBytes: number) => {
      const db = drizzle(pool, { schema: tables });
      const budget = new RequestBudget({ timeoutMs: 30_000, maxBytes });
      return execute({
        schema: buildGraphQLSchema({ schema: tables }),
        contextValue: {
          db,
          budget,
          getDataLoader: buildDataLoaderCache({ db, budget }),
          status: async () => ({}),
        },
        document: parse(
          `{ persons { items { id pets(limit: 1000) { items { id owner { name } } } } } }`,
        ),
      });
    };
    const small = await run(64 * 1024);
    expect(small.errors?.[0]?.message).toMatch(/query reads more than 0\.1 MB of rows/);
    const enough = await run(64 * 2 ** 20);
    expect(enough.errors).toBeUndefined();
    expect((enough.data as any).persons.items).toHaveLength(50);
  } finally {
    await pool.end();
  }
});
