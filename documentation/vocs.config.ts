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
      items: [{ text: "Get started", link: "/docs/get-started" }],
    },
  ],
  topNav: [{ text: "Docs", link: "/docs/get-started", match: "/docs" }],
  socials: [{ icon: "github", link: "https://github.com/swan-of-bodom/kasbah" }],
});
