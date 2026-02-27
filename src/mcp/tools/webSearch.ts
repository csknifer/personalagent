/**
 * Web search tools for MCP
 */

import { lookup } from 'dns/promises';
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
 * Check whether a hostname resolves to a private/internal network address.
 * Used to prevent SSRF attacks by blocking requests to internal services.
 */
/**
 * Check whether an IP address string is in a private/reserved range.
 */
function isPrivateIPv4(ip: string): boolean {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [, a, b] = match.map(Number);
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local / cloud metadata
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Well-known private hostnames
  if (lower === 'localhost') return true;

  // IPv6 loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;

  // IPv6 link-local (fe80::/10)
  if (lower.startsWith('fe80:') || lower.startsWith('fe80%')) return true;

  // IPv6 unique-local (fc00::/7 — covers fc00:: and fd00::)
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    // Verify it's actually an IPv6 address (contains ':')
    if (lower.includes(':')) return true;
  }

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  const mappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedMatch) {
    return isPrivateIPv4(mappedMatch[1]);
  }

  // Plain IPv4
  if (isPrivateIPv4(lower)) return true;

  return false;
}

/**
 * Resolve a hostname via DNS and check whether the resolved IP is private.
 * Prevents DNS rebinding attacks where a public hostname resolves to a private IP.
 */
export async function resolveAndCheckHost(hostname: string): Promise<{ isPrivate: boolean; resolvedIP?: string }> {
  // Skip DNS lookup for raw IP addresses — just check directly
  if (isPrivateHost(hostname)) {
    return { isPrivate: true, resolvedIP: hostname };
  }

  try {
    const { address } = await lookup(hostname);
    if (isPrivateHost(address)) {
      return { isPrivate: true, resolvedIP: address };
    }
    return { isPrivate: false, resolvedIP: address };
  } catch {
    // DNS resolution failed — reject to be safe
    return { isPrivate: true };
  }
}

const MAX_REDIRECTS = 5;

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

    // SSRF protection: block requests to private/internal network addresses
    // Resolve DNS to catch rebinding attacks (public hostname → private IP)
    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
    const dnsCheck = await resolveAndCheckHost(hostname);
    if (dnsCheck.isPrivate) {
      return { success: false, error: `Fetching internal/private network addresses is not allowed: "${hostname}"${dnsCheck.resolvedIP ? ` (resolves to ${dnsCheck.resolvedIP})` : ''}` };
    }

    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    // Follow redirects manually to validate each target against SSRF rules
    let currentUrl = url;
    let response: Response | undefined;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      response = await fetch(currentUrl, {
        headers: fetchHeaders,
        redirect: 'manual',
      });

      // Handle redirects (3xx with Location header)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect (${response.status}) without Location header`);
        }

        // Resolve relative redirect URLs
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, currentUrl);
        } catch {
          throw new Error(`Invalid redirect URL: "${location}"`);
        }

        // Validate redirect target scheme
        if (redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:') {
          return {
            success: false,
            error: `Redirect to "${redirectUrl.protocol}" scheme is not allowed. Only http and https are permitted.`,
          };
        }

        // Validate redirect target hostname against SSRF
        const redirectHostname = redirectUrl.hostname.replace(/^\[|\]$/g, '');
        if (isPrivateHost(redirectHostname)) {
          return { success: false, error: `Fetching internal/private network addresses is not allowed: "${redirectHostname}"` };
        }

        currentUrl = redirectUrl.href;
        if (i === MAX_REDIRECTS) {
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
        }
        continue;
      }

      break;
    }

    if (!response || !response.ok) {
      const status = response ? `${response.status} ${response.statusText}` : 'no response';
      throw new Error(`HTTP error: ${status}`);
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
