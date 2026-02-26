/**
 * Custom hook for chat state management with MCP tool and skill integration
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message } from '../../core/types.js';
import type { LLMProvider, StreamChunk, ToolCall } from '../../providers/index.js';
import type { MCPServer } from '../../mcp/MCPServer.js';
import type { SkillLoader } from '../../skills/SkillLoader.js';
import { SkillExecutor, createSkillExecutor } from '../../skills/SkillExecutor.js';

interface UseChatOptions {
  provider: LLMProvider;
  mcpServer?: MCPServer;
  skillLoader?: SkillLoader;
  systemPrompt?: string;
  onError?: (error: Error) => void;
}

interface UseChatReturn {
  messages: Message[];
  isLoading: boolean;
  streamingContent: string;
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
  addSystemMessage: (content: string) => void;
}

export function useChat({ provider, mcpServer, skillLoader, systemPrompt, onError }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>(() => {
    if (systemPrompt) {
      return [{
        role: 'system' as const,
        content: systemPrompt,
        timestamp: new Date(),
      }];
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  
  // Create skill executor if we have both skillLoader and mcpServer
  const skillExecutorRef = useRef<SkillExecutor | null>(null);
  useEffect(() => {
    if (skillLoader && mcpServer) {
      skillExecutorRef.current = createSkillExecutor(provider, mcpServer);
    }
  }, [provider, mcpServer, skillLoader]);

  const sendMessage = useCallback(async (content: string) => {
    // Add user message
    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: new Date(),
    };
    
    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    setStreamingContent('');

    try {
      let finalResponse: string;
      
      // Check for matching skills first
      const matchedSkill = skillLoader?.matchSkills(content)?.[0];
      
      if (matchedSkill && skillExecutorRef.current) {
        // Execute via skill
        setStreamingContent(`[Activating skill: ${matchedSkill.metadata.name}...]`);
        
        // Load the full skill
        const loadedSkill = await skillLoader.loadSkill(matchedSkill.id);
        
        if (loadedSkill) {
          setStreamingContent(`[Skill loaded: ${loadedSkill.metadata.name}]\n\nProcessing...`);
          const result = await skillExecutorRef.current.execute(loadedSkill, content);
          
          if (result.success) {
            finalResponse = result.output;
          } else {
            // Fall back to normal processing if skill fails
            finalResponse = await processWithTools(content);
          }
        } else {
          // Fall back to normal processing if skill loading fails
          finalResponse = await processWithTools(content);
        }
      } else {
        // No matching skill, process normally with tools
        finalResponse = await processWithTools(content);
      }

      // Add assistant message
      const assistantMessage: Message = {
        role: 'assistant',
        content: finalResponse,
        timestamp: new Date(),
        metadata: {
          model: provider.model,
          provider: provider.name,
        },
      };

      setMessages(prev => [...prev, assistantMessage]);
      setStreamingContent('');
      
      // Helper function to process with tools
      async function processWithTools(userContent: string): Promise<string> {
        const conversationMessages = [...messages, { role: 'user' as const, content: userContent, timestamp: new Date() }];
        const tools = mcpServer?.getToolDefinitions();
        
        return processConversation(
          provider,
          mcpServer,
          conversationMessages,
          tools,
          (streamContent) => setStreamingContent(streamContent)
        );
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      onError?.(err);
      
      // Add error message
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${err.message}`,
        timestamp: new Date(),
      }]);
    } finally {
      setIsLoading(false);
      setStreamingContent('');
    }
  }, [messages, provider, mcpServer, skillLoader, onError]);

  const clearMessages = useCallback(() => {
    setMessages(systemPrompt ? [{
      role: 'system',
      content: systemPrompt,
      timestamp: new Date(),
    }] : []);
  }, [systemPrompt]);

  const addSystemMessage = useCallback((content: string) => {
    setMessages(prev => [...prev, {
      role: 'system',
      content,
      timestamp: new Date(),
    }]);
  }, []);

  return {
    messages,
    isLoading,
    streamingContent,
    sendMessage,
    clearMessages,
    addSystemMessage,
  };
}

/**
 * Process a conversation, handling tool calls if needed
 */
async function processConversation(
  provider: LLMProvider,
  mcpServer: MCPServer | undefined,
  messages: Message[],
  tools: ReturnType<MCPServer['getToolDefinitions']> | undefined,
  onStreamUpdate: (content: string) => void,
  maxToolRounds: number = 5
): Promise<string> {
  let currentMessages = [...messages];
  let fullResponse = '';
  let toolRound = 0;

  while (toolRound < maxToolRounds) {
    const pendingToolCalls: ToolCall[] = [];
    let responseText = '';

    // Stream the response
    for await (const chunk of provider.chatStream(currentMessages, { tools })) {
      if (chunk.type === 'text' && chunk.content) {
        responseText += chunk.content;
        fullResponse = responseText;
        onStreamUpdate(fullResponse);
      } else if (chunk.type === 'tool_call' && chunk.toolCall) {
        pendingToolCalls.push(chunk.toolCall);
        // Show tool call in progress
        fullResponse = responseText + `\n[Using tool: ${chunk.toolCall.name}...]`;
        onStreamUpdate(fullResponse);
      }
    }

    // If no tool calls, we're done
    if (pendingToolCalls.length === 0 || !mcpServer) {
      return responseText;
    }

    // Execute tool calls and build tool results
    const toolResults: Array<{ name: string; result: string }> = [];
    
    for (const toolCall of pendingToolCalls) {
      try {
        const result = await mcpServer.executeToolCall(toolCall);
        const resultStr = result.success 
          ? JSON.stringify(result.data, null, 2) 
          : `Error: ${result.error}`;
        toolResults.push({ name: toolCall.name, result: resultStr });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        toolResults.push({ name: toolCall.name, result: `Error: ${err.message}` });
      }
    }

    // Build tool results message
    let toolResultsContent = '## Tool Results\n\n';
    for (const { name, result } of toolResults) {
      toolResultsContent += `### ${name}\n\`\`\`json\n${result}\n\`\`\`\n\n`;
    }
    toolResultsContent += 'Based on these tool results, please provide a complete response.';

    // Add assistant response and tool results to conversation
    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: responseText, timestamp: new Date() },
      { role: 'user' as const, content: toolResultsContent, timestamp: new Date() },
    ];

    // Update display to show we're processing tool results
    fullResponse = responseText + '\n\n[Processing tool results...]';
    onStreamUpdate(fullResponse);

    toolRound++;
  }

  return fullResponse;
}
