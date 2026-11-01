import { desc } from "kasbah";
import app from "../../kasbah.config.ts";
import * as schema from "../../kasbah.schema.ts";

app.get("/class_hash_replaced/latest", async ({ db }) =>
  db
    .select()
    .from(schema.classHashReplaced)
    .orderBy(desc(schema.classHashReplaced.block))
    .limit(10),
);
