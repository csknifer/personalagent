/**
 * Skill Executor - Executes skills with LLM integration
 */

import type { Skill } from './SkillLoader.js';
import type { LLMProvider } from '../providers/index.js';
import type { MCPServer } from '../mcp/MCPServer.js';

export interface SkillExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface SkillExecutorOptions {
  provider: LLMProvider;
  mcpServer?: MCPServer;
}

export class SkillExecutor {
  private provider: LLMProvider;
  private mcpServer?: MCPServer;

  constructor(options: SkillExecutorOptions) {
    this.provider = options.provider;
    this.mcpServer = options.mcpServer;
  }

  /**
   * Execute a skill with the given context
   */
  async execute(
    skill: Skill,
    userQuery: string,
    context?: Record<string, unknown>
  ): Promise<SkillExecutionResult> {
    if (!skill.loaded || !skill.content) {
      return {
        success: false,
        output: '',
        error: 'Skill not fully loaded',
      };
    }

    try {
      // Build the skill prompt
      const prompt = this.buildSkillPrompt(skill, userQuery, context);

      // Get tool definitions if MCP is available
      const tools = this.mcpServer?.getToolDefinitions();

      // Execute with LLM
      const response = await this.provider.chat(
        [{ role: 'user', content: prompt, timestamp: new Date() }],
        { tools }
      );

      // Handle any tool calls
      if (response.toolCalls && response.toolCalls.length > 0 && this.mcpServer) {
        const toolResults = await this.executeToolCalls(response.toolCalls);
        
        // Continue conversation with tool results
        const followUpPrompt = this.buildToolResultPrompt(response.content, toolResults);
        const finalResponse = await this.provider.chat([
          { role: 'user', content: prompt, timestamp: new Date() },
          { role: 'assistant', content: response.content, timestamp: new Date() },
          { role: 'user', content: followUpPrompt, timestamp: new Date() },
        ]);

        return {
          success: true,
          output: finalResponse.content,
          metadata: {
            toolsUsed: response.toolCalls.map(tc => tc.name),
            tokenUsage: finalResponse.tokenUsage,
          },
        };
      }

      return {
        success: true,
        output: response.content,
        metadata: {
          tokenUsage: response.tokenUsage,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        output: '',
        error: err.message,
      };
    }
  }

  /**
   * Build the prompt for skill execution
   */
  private buildSkillPrompt(
    skill: Skill,
    userQuery: string,
    context?: Record<string, unknown>
  ): string {
    let prompt = `# Skill: ${skill.metadata.name}

## Instructions
${skill.content}

`;

    // Add resources if available
    if (skill.resources && skill.resources.size > 0) {
      prompt += `## Resources\n`;
      for (const [name, content] of skill.resources) {
        prompt += `### ${name}\n${content}\n\n`;
      }
    }

    // Add context if provided
    if (context && Object.keys(context).length > 0) {
      prompt += `## Context\n`;
      for (const [key, value] of Object.entries(context)) {
        prompt += `- ${key}: ${JSON.stringify(value)}\n`;
      }
      prompt += '\n';
    }

    prompt += `## User Request
${userQuery}

## Instructions
Follow the skill instructions above to complete the user's request. Be thorough and accurate.
`;

    return prompt;
  }

  /**
   * Execute tool calls from LLM response
   */
  private async executeToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  ): Promise<Array<{ name: string; result: unknown }>> {
    if (!this.mcpServer) {
      return [];
    }

    const results: Array<{ name: string; result: unknown }> = [];

    for (const toolCall of toolCalls) {
      const result = await this.mcpServer.executeTool(toolCall.name, toolCall.arguments);
      results.push({
        name: toolCall.name,
        result: result.success ? result.data : result.error,
      });
    }

    return results;
  }

  /**
   * Build prompt with tool results
   */
  private buildToolResultPrompt(
    previousResponse: string,
    toolResults: Array<{ name: string; result: unknown }>
  ): string {
    let prompt = `## Tool Results\n\n`;
    
    for (const { name, result } of toolResults) {
      prompt += `### ${name}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\n`;
    }

    prompt += `Based on these tool results, provide a complete response to the user's request.`;
    
    return prompt;
  }

  /**
   * Update the provider
   */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  /**
   * Update the MCP server
   */
  setMCPServer(mcpServer: MCPServer): void {
    this.mcpServer = mcpServer;
  }
}

/**
 * Create a skill executor
 */
export function createSkillExecutor(
  provider: LLMProvider,
  mcpServer?: MCPServer
): SkillExecutor {
  return new SkillExecutor({ provider, mcpServer });
}
