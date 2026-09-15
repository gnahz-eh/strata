export function activate(api) {
  api.registerTool({
    name: "project_info",
    description: "Return the current working directory and operating system platform.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    needsPermission: false,
    async run(_input, context) {
      if (!context) throw new Error("project_info requires a tool context.");
      return JSON.stringify({ cwd: context.cwd, platform: process.platform });
    },
  });
}