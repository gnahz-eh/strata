export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  needsPermission?: boolean;
  run: (input: any) => Promise<string>;
}