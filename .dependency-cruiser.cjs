module.exports = {
  forbidden: [
    {
      name: "core-to-adapter-boundary",
      severity: "error",
      from: { path: "^packages/core/src" },
      to: { path: "^packages/(cli|mcp-adapter|ui|python-adapters)/" },
      comment: "Core must remain protocol-independent."
    },
    {
      name: "ui-to-adapter-boundary",
      severity: "error",
      from: { path: "^packages/ui/src" },
      to: { path: "^packages/(cli|mcp-adapter|python-adapters)/" },
      comment: "UI can consume Core API types and HTTP endpoints but not adapter internals."
    }
  ],
  options: {
    doNotFollow: { path: "node_modules|dist|runs|coverage" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "node", "default"]
    }
  }
};
