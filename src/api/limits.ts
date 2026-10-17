import {
  type DocumentNode,
  type FragmentDefinitionNode,
  GraphQLError,
  Kind,
  parse,
  type SelectionSetNode,
} from "graphql";

export const MAX_TOKENS = 1_000;
/** Each nested relation runs its own statement, so depth is what multiplies a query's cost. */
export const MAX_DEPTH = 20;
export const MAX_ALIASES = 30;

/** Parses `source`, refusing a document over the token, depth or alias limits (fragments counted where spread). */
export function parseLimited(source: string): DocumentNode {
  const doc = parse(source, { maxTokens: MAX_TOKENS });
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const d of doc.definitions)
    if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);

  let aliases = 0;
  const depth = (set: SelectionSetNode, inside: ReadonlySet<string>): number => {
    let max = 0;
    for (const s of set.selections) {
      if (s.kind === Kind.FIELD) {
        if (s.alias !== undefined && ++aliases > MAX_ALIASES)
          throw new GraphQLError(`more than ${MAX_ALIASES} aliases`);
        max = Math.max(max, 1 + (s.selectionSet === undefined ? 0 : depth(s.selectionSet, inside)));
      } else if (s.kind === Kind.INLINE_FRAGMENT)
        max = Math.max(max, depth(s.selectionSet, inside));
      else {
        const f = fragments.get(s.name.value);
        // A cycle or an unknown fragment is left to validation, which reports it.
        if (f !== undefined && !inside.has(f.name.value))
          max = Math.max(max, depth(f.selectionSet, new Set([...inside, f.name.value])));
      }
      if (max > MAX_DEPTH) throw new GraphQLError(`query deeper than ${MAX_DEPTH} levels`);
    }
    return max;
  };
  for (const d of doc.definitions)
    if (d.kind === Kind.OPERATION_DEFINITION) depth(d.selectionSet, new Set());
  return doc;
}
