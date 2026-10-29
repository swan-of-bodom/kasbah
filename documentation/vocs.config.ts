import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "kasbah",
  titleTemplate: "%s – kasbah",
  description: "A minimal, fast Starknet indexer in TypeScript.",
  twoslash: false,
  // Plain HTML files: any static host serves it, no server needed.
  renderStrategy: "full-static",
  sidebar: [
    {
      text: "Introduction",
      items: [
        { text: "Overview", link: "/docs" },
        { text: "Installation", link: "/docs/installation" },
        { text: "Quickstart", link: "/docs/quickstart" },
        { text: "Project layout", link: "/docs/project-layout" },
      ],
    },
    {
      text: "Config",
      items: [
        { text: "Network and RPC", link: "/docs/config/network" },
        { text: "Contracts", link: "/docs/config/contracts" },
        { text: "Block intervals", link: "/docs/config/blocks" },
        { text: "Options", link: "/docs/config/options" },
      ],
    },
    {
      text: "Indexing",
      items: [
        { text: "Handlers", link: "/docs/indexing/handlers" },
        { text: "Tables and writes", link: "/docs/indexing/database" },
        { text: "Read contracts", link: "/docs/indexing/read-contracts" },
      ],
    },
    {
      text: "Query",
      items: [
        { text: "SQL over HTTP", link: "/docs/query/sql" },
        { text: "GraphQL", link: "/docs/query/graphql" },
        { text: "Live queries", link: "/docs/query/live" },
        { text: "API routes", link: "/docs/query/routes" },
      ],
    },
    {
      text: "Production",
      items: [
        { text: "CLI", link: "/docs/production/cli" },
        { text: "Deploy", link: "/docs/production/deploy" },
        { text: "Monitoring", link: "/docs/production/monitoring" },
      ],
    },
  ],
  topNav: [
    { text: "Docs", link: "/docs", match: "/docs" },
    {
      text: "Changelog",
      link: "https://github.com/swan-of-bodom/kasbah/blob/main/CHANGELOG.md",
    },
  ],
  socials: [{ icon: "github", link: "https://github.com/swan-of-bodom/kasbah" }],
});
