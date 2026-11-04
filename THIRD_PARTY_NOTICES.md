# Third-party notices

Parts of kasbah are adapted from other projects under the MIT license. Their notices follow.

## Ponder

<https://github.com/ponder-sh/ponder>. kasbah's API follows Ponder's, and these files adapt its code:

| kasbah | Ponder (`packages/`) |
| --- | --- |
| `src/api/graphql/schema.ts` | `core/src/graphql/index.ts`, `normalizeColumn` from `core/src/indexing-store/utils.ts` |
| `src/api/graphql/json.ts` | `core/src/graphql/json.ts` |
| `src/api/graphql/middleware.ts` | `core/src/graphql/middleware.ts` |
| `src/api/graphql/graphiql.ts` | `core/src/graphql/graphiql.html.ts` |
| `src/api/server.ts` (built-in endpoints, error responses) | `core/src/server/index.ts` |
| `src/utils/replace-bigints.ts` | `utils/src/replaceBigInts.ts` |
| `test/unit/graphql.test.ts` | `core/src/graphql/index.test.ts` |

```
MIT License

Copyright (c) 2023 Cantrip, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## graphql-type-json

<https://github.com/taion/graphql-type-json>, which Ponder's `json.ts` adapts in turn: `src/api/graphql/json.ts`.

```
The MIT License (MIT)

Copyright (c) 2016 Jimmy Jia

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
