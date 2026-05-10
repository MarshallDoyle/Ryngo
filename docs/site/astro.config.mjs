import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://codegraph.dev",
  integrations: [
    starlight({
      title: "codegraph",
      description:
        "Static-analysis tool that compiles your codebase into a typed graph IR and diffs it on every PR.",
      social: {
        github: "https://github.com/codegraph/codegraph",
      },
      editLink: {
        baseUrl:
          "https://github.com/codegraph/codegraph/edit/main/docs/site/",
      },
      sidebar: [
        {
          label: "Getting started",
          collapsed: false,
          items: [
            { label: "Overview", link: "/getting-started/" },
            { label: "Install", link: "/getting-started/install/" },
            { label: "Your first index", link: "/getting-started/first-index/" },
            { label: "Viewing the graph", link: "/getting-started/viewing-the-graph/" },
            { label: "Your first PR comment", link: "/getting-started/first-pr-comment/" },
          ],
        },
        {
          label: "Concepts",
          collapsed: true,
          items: [
            { label: "Mental model", link: "/concepts/" },
            { label: "The IR", link: "/concepts/ir/" },
            { label: "Nodes & tiers", link: "/concepts/nodes-and-tiers/" },
            { label: "Edges & types", link: "/concepts/edges-and-types/" },
            { label: "Adapters", link: "/concepts/adapters/" },
            { label: "Pure vs effectful", link: "/concepts/pure-vs-effectful/" },
            { label: "Diff & PR comments", link: "/concepts/diff-and-pr-comments/" },
          ],
        },
        {
          label: "CLI reference",
          collapsed: true,
          items: [
            { label: "Command index", link: "/cli/" },
            { label: "codegraph index", link: "/cli/index-command/" },
            { label: "codegraph diff", link: "/cli/diff/" },
            { label: "codegraph serve", link: "/cli/serve/" },
            { label: "codegraph export", link: "/cli/export/" },
            { label: "codegraph init", link: "/cli/init/" },
            { label: "codegraph adapter", link: "/cli/adapter/" },
          ],
        },
        {
          label: "GitHub Action",
          collapsed: true,
          items: [
            { label: "Overview", link: "/github-action/" },
            { label: "Install", link: "/github-action/install/" },
            { label: "Inputs", link: "/github-action/inputs/" },
            { label: "Examples", link: "/github-action/examples/" },
            { label: "Troubleshooting", link: "/github-action/troubleshooting/" },
          ],
        },
        {
          label: "Viewer",
          collapsed: true,
          items: [
            { label: "Tour", link: "/viewer/" },
            { label: "Keyboard shortcuts", link: "/viewer/keyboard-shortcuts/" },
            { label: "Drill-down", link: "/viewer/drill-down/" },
            { label: "Filtering", link: "/viewer/filtering/" },
            { label: "Exports", link: "/viewer/exports/" },
          ],
        },
        {
          label: "Configuration",
          collapsed: true,
          items: [
            { label: ".codegraph.yml", link: "/configuration/codegraph-yml/" },
          ],
        },
        {
          label: "Writing an adapter",
          collapsed: true,
          items: [
            { label: "Overview", link: "/adapters/" },
            { label: "Adapter SDK", link: "/adapters/sdk/" },
            { label: "Lifecycle", link: "/adapters/lifecycle/" },
            { label: "Examples", link: "/adapters/examples/" },
            { label: "Publishing", link: "/adapters/publishing/" },
          ],
        },
        {
          label: "Recipes",
          collapsed: true,
          items: [
            { label: "Recipe index", link: "/recipes/" },
            { label: "DB writes from HTTP", link: "/recipes/db-writes-from-http/" },
            { label: "New sinks in a PR", link: "/recipes/new-sinks-in-pr/" },
            { label: "Embed a subgraph in your README", link: "/recipes/embed-subgraph-readme/" },
          ],
        },
        {
          label: "FAQ",
          link: "/faq/",
        },
        {
          label: "Contributing",
          collapsed: true,
          items: [
            { label: "Overview", link: "/contributing/" },
            { label: "Development setup", link: "/contributing/development-setup/" },
            { label: "Architecture", link: "/contributing/architecture/" },
            { label: "Editing the docs", link: "/contributing/docs/" },
          ],
        },
      ],
    }),
  ],
});
