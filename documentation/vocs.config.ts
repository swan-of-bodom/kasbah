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
        { text: "What is kasbah?", link: "/docs" },
        { text: "Why kasbah?", link: "/docs/why" },
        { text: "Installation", link: "/docs/installation" },
        { text: "Quickstart", link: "/docs/quickstart" },
        { text: "Project layout", link: "/docs/project-layout" },
        { text: "Database", link: "/docs/database" },
        { text: "Other indexing tools", link: "/docs/other-indexing-tools" },
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
      text: "Guides",
      items: [{ text: "Time-series data", link: "/docs/guides/time-series" }],
    },
    {
      text: "Production",
      items: [
        { text: "Self-hosting", link: "/docs/production/self-hosting" },
        { text: "Railway", link: "/docs/production/railway" },
        { text: "Render", link: "/docs/production/render" },
        { text: "VPS", link: "/docs/production/vps" },
        { text: "Monitoring", link: "/docs/production/monitoring" },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "kasbah.config.ts", link: "/docs/reference/config" },
        { text: "CLI", link: "/docs/reference/cli" },
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
