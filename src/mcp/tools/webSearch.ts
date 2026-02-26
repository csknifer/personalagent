/**
 * Web search tools for MCP
 */

import { parseHTML } from 'linkedom';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchToolResult {
  success: boolean;
  data?: {
    query: string;
    results: WebSearchResult[];
  };
  error?: string;
}

export interface FetchResult {
  success: boolean;
  data?: {
    url: string;
    content: string;
    contentType?: string;
  };
  error?: string;
}

/**
 * Search the web using Tavily API
 */
export async function webSearchTool(
  query: string,
  apiKey: string,
  maxResults: number = 5
): Promise<WebSearchToolResult> {
  if (!apiKey) {
    return {
      success: false,
      error: 'Tavily API key not configured. Set TAVILY_API_KEY environment variable.',
    };
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
      }),
    });

    if (!response.ok) {
      // Tavily-specific error codes with actionable messages
      if (response.status === 432) {
        throw new Error('Tavily plan limit exceeded — monthly search quota used up. Upgrade your Tavily plan or wait for the next billing cycle. web_search will not work until this is resolved.');
      }
      if (response.status === 429) {
        throw new Error('Tavily rate limit exceeded — too many requests per minute. Wait briefly before retrying.');
      }
      if (response.status === 401) {
        throw new Error('Tavily API key is invalid or missing. Check your TAVILY_API_KEY environment variable.');
      }
      throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      results: Array<{
        title: string;
        url: string;
        content: string;
      }>;
    };

    const results: WebSearchResult[] = data.results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));

    return {
      success: true,
      data: {
        query,
        results,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: `Web search failed: ${err.message}`,
    };
  }
}

/**
 * Fetch content from a URL
 */
export async function fetchUrlTool(url: string): Promise<FetchResult> {
  try {
    // Validate URL scheme — only http and https are permitted
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { success: false, error: `Invalid URL: "${url}"` };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        success: false,
        error: `URL scheme "${parsedUrl.protocol}" is not allowed. Only http and https are permitted.`,
      };
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'text/plain';
    const content = await response.text();

    // HTML to text conversion using DOM-aware extraction
    let cleanContent = content;
    if (contentType.includes('text/html')) {
      cleanContent = htmlToText(content);
    }

    return {
      success: true,
      data: {
        url,
        content: cleanContent.slice(0, 50000), // Limit content size
        contentType,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: `Failed to fetch URL: ${err.message}`,
    };
  }
}

/**
 * Convert HTML to readable text using linkedom DOM parsing.
 * Removes non-content elements (scripts, styles, nav, footer, etc.)
 * and prefers article/main content when available.
 */
export function htmlToText(html: string): string {
  try {
    const { document } = parseHTML(html);

    // Remove non-content elements
    const removeTags = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'svg', 'iframe'];
    for (const tag of removeTags) {
      document.querySelectorAll(tag).forEach((el: { remove(): void }) => el.remove());
    }

    // Prefer article/main content over full body
    const main = document.querySelector('article, main, [role="main"]');
    const target = main || document.body;

    const text = target?.textContent || '';
    // Collapse whitespace
    return text.replace(/\s+/g, ' ').trim();
  } catch {
    // Fallback: basic regex strip if DOM parsing fails
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/\s+/g, ' ');
    return text.trim();
  }
}

/**
 * Tool definition for the Tavily web_search tool (only register when API key present).
 */
export function getTavilyToolDefinition() {
  return {
    name: 'web_search',
    description: 'Search the web for information using Tavily',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
        },
      },
      required: ['query'],
    },
  };
}

/**
 * Tool definition for fetch_url (always available, no API key required).
 */
export function getFetchUrlToolDefinition() {
  return {
    name: 'fetch_url',
    description: 'Fetch and extract content from a URL',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
      },
      required: ['url'],
    },
  };
}

/**
 * Get web search tool definitions for MCP.
 * @deprecated Use getTavilyToolDefinition() and getFetchUrlToolDefinition() directly.
 */
export function getWebSearchToolDefinitions() {
  return [getTavilyToolDefinition(), getFetchUrlToolDefinition()];
}
