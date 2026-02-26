/**
 * Adapter layer for converting between internal ToolResult format
 * and the MCP SDK's CallToolResult format.
 */

/**
 * Internal tool result format used throughout the codebase.
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * MCP SDK CallToolResult shape (defined here to avoid tight coupling
 * to the SDK's exact export paths in consuming code).
 */
export interface MCPCallToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * Convert an internal ToolResult to an MCP CallToolResult.
 *
 * Success: data is JSON-stringified as a text content block.
 * Failure: error string becomes a text content block with isError = true.
 */
export function toolResultToMCP(result: ToolResult): MCPCallToolResult {
  if (!result.success) {
    return {
      content: [{ type: 'text', text: result.error ?? 'Unknown error' }],
      isError: true,
    };
  }

  const text = typeof result.data === 'string'
    ? result.data
    : JSON.stringify(result.data, null, 2);

  return {
    content: [{ type: 'text', text: text ?? '' }],
    isError: false,
  };
}

/**
 * Convert an MCP CallToolResult back to the internal ToolResult format.
 *
 * Concatenates all text content blocks into a single string.
 * If isError is true, surfaces the text as error.
 * Attempts to parse JSON to restore structured data.
 */
export function mcpToToolResult(mcpResult: MCPCallToolResult): ToolResult {
  const textBlocks = (mcpResult.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n');

  if (mcpResult.isError) {
    return { success: false, error: textBlocks || 'Tool call failed' };
  }

  // Try to parse as JSON to restore structured data; fall back to raw string
  try {
    return { success: true, data: JSON.parse(textBlocks) };
  } catch {
    return { success: true, data: textBlocks };
  }
}
