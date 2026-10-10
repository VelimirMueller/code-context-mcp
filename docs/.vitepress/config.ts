import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Code Context MCP",
  description: "Living documentation for the code-context MCP server",
  ignoreDeadLinks: [/^http:\/\/localhost/],
  srcExclude: ["superpowers/**", "CLAUDE-PROJECT.md"],
  appearance: "dark",
  head: [
    ["link", { rel: "preconnect", href: "https://cdn.jsdelivr.net" }],
  ],
  themeConfig: {
    siteTitle: "CC MCP",
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/" },
      { text: "Tools", link: "/tools/" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/" },
          { text: "Architecture", link: "/guide/architecture" },
        ],
      },
      {
        text: "MCP Tools",
        items: [
          { text: "Overview", link: "/tools/" },
          { text: "index_directory", link: "/tools/index-directory" },
          { text: "find_symbol", link: "/tools/find-symbol" },
          { text: "get_file_context", link: "/tools/get-file-context" },
          { text: "get_changes", link: "/tools/get-changes" },
          { text: "search_files", link: "/tools/search-files" },
          { text: "query / execute", link: "/tools/query-execute" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/VelimirMueller" },
    ],
    footer: {
      message: "Built by Velimir Muller.",
      copyright: "Code Context MCP Server",
    },
  },
});
