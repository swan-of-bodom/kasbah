# Contributing

Thanks for helping with kasbah. This page gets you from a fresh clone to a pull request. If you're not sure where
to start, open an [issue](https://github.com/swan-of-bodom/kasbah/issues) and ask.

- [Set up](#set-up)
- [Run the tests](#run-the-tests)
- [Work on the docs](#work-on-the-docs)
- [Open a pull request](#open-a-pull-request)
- [Releases](#releases)

## Set up

You need **Node.js 24** and **pnpm** (the version is pinned in `package.json`; `corepack enable` picks it up).

```bash
gh repo fork swan-of-bodom/kasbah --clone
cd kasbah
pnpm install        # also points git at .githooks: a commit Biome would change is refused
```

To try your change in an app, pack it and install the tarball there:

```bash
pnpm pack
cd ../my-indexer && pnpm add ../kasbah/kasbah-*.tgz
```

## Run the tests

Most tests run against fake Starknet nodes, so they need no RPC. The ones that store data need a Postgres they
may create schemas in:

```bash
docker run -d --name kasbah-pg -e POSTGRES_PASSWORD=kasbah -e POSTGRES_DB=kasbah \
  -p 127.0.0.1:5544:5432 docker.io/library/postgres:17
echo 'DATABASE_URL=postgresql://postgres:kasbah@127.0.0.1:5544/kasbah' >> .env
```

```bash
pnpm test                          # everything
pnpm test test/unit/filters.test.ts   # one file
pnpm typecheck                     # includes the type tests on real ABIs
pnpm lint:fix                      # Biome: format and lint
```

A fix or feature comes with a test that fails without it.

## Work on the docs

The site is [Vocs](https://vocs.dev), in `documentation/`:

```bash
cd documentation && pnpm install && pnpm dev
```

It deploys to [GitHub Pages](https://swan-of-bodom.github.io/kasbah/) on every push to `main` that touches it.

## Open a pull request

- Keep it to one change. Its title, like its commits, is one short sentence in the imperative ("Add …", "Fix …").
- Update what users would notice in the same PR: the docs, and an entry under **Unreleased** in `CHANGELOG.md`.
- CI runs lint, typecheck and the tests against Postgres. If it fails, the Actions logs say why.
- [AGENTS.md](../AGENTS.md) has the code rules (config defaults, errors, comments).

## Releases

Maintainers release by publishing a GitHub release (`vX.Y.Z`), after setting that version in `package.json`,
`create/package.json` (and its `kasbah` dependency) and moving the **Unreleased** notes under it. The
[release workflow](workflows/release.yml) stages both packages on npm with provenance, and a maintainer approves
them on npmjs.com. While kasbah is 0.x, a minor version may break the config or the API, and a patch never does.

---

This guide follows the shape of [Ponder's](https://github.com/ponder-sh/ponder/blob/main/.github/CONTRIBUTING.md).
