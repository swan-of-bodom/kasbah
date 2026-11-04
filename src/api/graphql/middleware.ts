import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { maxAliasesPlugin } from "@escape.tech/graphql-armor-max-aliases";
import { maxDepthPlugin } from "@escape.tech/graphql-armor-max-depth";
import { maxTokensPlugin } from "@escape.tech/graphql-armor-max-tokens";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { type GraphQLSchema, printSchema } from "graphql";
import { createYoga } from "graphql-yoga";
import { createMiddleware } from "hono/factory";
import { tableInfo } from "../../db/table.ts";
import { currentApi, type Tables } from "../context.ts";
import { graphiQLHtml } from "./graphiql.ts";
import { createGraphqlSchema, type GraphqlContext, relationsOf } from "./schema.ts";

/** Limits on one operation; the defaults are Apollo's, from its advice on operation size and complexity. */
export type GraphqlLimits = {
  maxOperationTokens?: number;
  maxOperationDepth?: number;
  maxOperationAliases?: number;
};

/**
 * GraphQL over the app's tables, and GraphiQL for a browser's GET.
 *
 * @example
 * import { Hono } from "hono";
 * import { db, graphql } from "kasbah/api";
 * import * as schema from "../../kasbah.schema.ts";
 *
 * const app = new Hono();
 * app.use("/graphql", graphql({ db, schema }));
 * export default app;
 */
export function graphql(
  { schema }: { db: unknown; schema: Tables },
  {
    maxOperationTokens = 1000,
    maxOperationDepth = 100,
    maxOperationAliases = 30,
  }: GraphqlLimits = {},
) {
  const infos = Object.fromEntries(
    Object.entries(schema).flatMap(([k, t]) => (is(t, PgTable) ? [[k, tableInfo(t)]] : [])),
  );
  const graphqlSchema = createGraphqlSchema(infos, relationsOf(schema, infos));
  writeSchema(graphqlSchema).catch(() => {});

  const yoga = createYoga({
    // Hono routes; Yoga answers whatever reaches it.
    graphqlEndpoint: "*",
    schema: graphqlSchema,
    context: (): GraphqlContext => {
      const api = currentApi("graphql()");
      return { client: api.reader.pool, timeoutMs: api.reader.timeoutMs };
    },
    maskedErrors: process.env.NODE_ENV === "production",
    logging: false,
    graphiql: false,
    parserAndValidationCache: false,
    plugins: [
      maxTokensPlugin({ n: maxOperationTokens }),
      maxDepthPlugin({ n: maxOperationDepth, ignoreIntrospection: false }),
      maxAliasesPlugin({ n: maxOperationAliases, allowList: [] }),
    ],
  });

  return createMiddleware(async (c) => {
    if (c.req.method === "GET") return c.html(graphiQLHtml);
    const response = await yoga.handle(c.req.raw);
    if (response.status === 200) return response;
    // Yoga answers some GraphQL errors with a 500; a client reads them from the body.
    return new Response(response.body, {
      status: 200,
      statusText: "OK",
      headers: new Headers(response.headers),
    });
  });
}

/** `generated/schema.graphql`, for editors and code generators. */
async function writeSchema(schema: GraphQLSchema) {
  const dir = join(process.cwd(), "generated");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "schema.graphql"), printSchema(schema), "utf-8");
}
