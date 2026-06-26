import type { JsonObject, JsonSchema, JsonValue, RegisteredTool, ToolCall } from "./types.js";

export interface ArgumentValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.#tools.set(tool.toolName, tool);
  }

  get(toolName: string): RegisteredTool | undefined {
    return this.#tools.get(toolName);
  }

  list(): readonly RegisteredTool[] {
    return [...this.#tools.values()];
  }

  validateCall(call: ToolCall): ArgumentValidationResult {
    const tool = this.get(call.toolName);
    if (!tool) {
      return { valid: false, errors: [`Unknown tool: ${call.toolName}`] };
    }

    return validateJsonSchema(tool.inputSchema, call.arguments, "arguments");
  }
}

export function validateJsonSchema(schema: JsonSchema, value: JsonValue, path: string): ArgumentValidationResult {
  const errors: string[] = [];
  validate(schema, value, path, errors);
  return { valid: errors.length === 0, errors };
}

function validate(schema: JsonSchema, value: JsonValue, path: string, errors: string[]): void {
  if (schema.type && !matchesType(schema.type, value)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }

  if (schema.type === "object" || schema.properties || schema.required) {
    if (!isJsonObject(value)) {
      errors.push(`${path} must be object`);
      return;
    }

    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        const propertyValue = value[key];
        if (propertyValue !== undefined) {
          validate(propertySchema, propertyValue, `${path}.${key}`, errors);
        }
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
  }
}

function matchesType(type: JsonSchema["type"], value: JsonValue): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isJsonObject(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
