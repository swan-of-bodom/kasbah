import { load } from "../project.ts";

export async function serve(file: string) {
  const app = await load(file);
  const api = await app.serve();
  console.log(`[kasbah] API on ${api.url}: GraphiQL at ${api.url}/graphql (Ctrl-C stops it)`);
  await new Promise<void>((r) => {
    process.once("SIGINT", r);
    process.once("SIGTERM", r);
  });
  await api.close();
}
