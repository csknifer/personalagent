/**
 * Tests for htmlToText DOM-aware extraction.
 */

import { describe, it, expect } from 'vitest';
import { htmlToText, fetchUrlTool, isPrivateHost } from './webSearch.js';

describe('htmlToText', () => {
  it('extracts text from a simple HTML page', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    expect(htmlToText(html)).toBe('Hello world');
  });

  it('removes script and style elements', () => {
    const html = `
      <html><body>
        <script>var x = 1;</script>
        <style>.red { color: red; }</style>
        <p>Visible text</p>
      </body></html>
    `;
    const text = htmlToText(html);
    expect(text).toContain('Visible text');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('.red');
  });

  it('removes nav, footer, header, aside elements', () => {
    const html = `
      <html><body>
        <nav><a href="/">Home</a></nav>
        <header><h1>Site Title</h1></header>
        <main><p>Article content</p></main>
        <aside>Sidebar</aside>
        <footer>Copyright 2024</footer>
      </body></html>
    `;
    const text = htmlToText(html);
    expect(text).toBe('Article content');
  });

  it('prefers article content when present', () => {
    const html = `
      <html><body>
        <div>Outer text</div>
        <article>
          <h1>Article Title</h1>
          <p>Article body</p>
        </article>
        <div>More outer text</div>
      </body></html>
    `;
    const text = htmlToText(html);
    expect(text).toContain('Article Title');
    expect(text).toContain('Article body');
    expect(text).not.toContain('Outer text');
  });

  it('prefers main content when present', () => {
    const html = `
      <html><body>
        <div>Outer</div>
        <main><p>Main content here</p></main>
        <div>More outer</div>
      </body></html>
    `;
    const text = htmlToText(html);
    expect(text).toBe('Main content here');
  });

  it('prefers role="main" content', () => {
    const html = `
      <html><body>
        <div>Outer</div>
        <div role="main"><p>Role main content</p></div>
      </body></html>
    `;
    const text = htmlToText(html);
    expect(text).toBe('Role main content');
  });

  it('falls back to body when no article/main found', () => {
    const html = `
      <html><body>
        <div>Section one</div>
        <div>Section two</div>
      </body></html>
    `;
    const text = htmlToText(html);
    expect(text).toContain('Section one');
    expect(text).toContain('Section two');
  });

  it('collapses excess whitespace', () => {
    const html = '<html><body><p>  Multiple   spaces   and\n\nnewlines  </p></body></html>';
    expect(htmlToText(html)).toBe('Multiple spaces and newlines');
  });

  it('handles empty HTML gracefully', () => {
    expect(htmlToText('')).toBe('');
  });

  it('handles malformed HTML without crashing', () => {
    const html = '<html><body><div><p>Unclosed paragraph<div>Another div</span></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('Unclosed paragraph');
    expect(text).toContain('Another div');
  });
});

describe('isPrivateHost', () => {
  it('detects localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true);
  });

  it('detects 127.0.0.1', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
  });

  it('detects 127.x.x.x range', () => {
    expect(isPrivateHost('127.0.0.2')).toBe(true);
    expect(isPrivateHost('127.255.255.255')).toBe(true);
  });

  it('detects IPv6 loopback', () => {
    expect(isPrivateHost('::1')).toBe(true);
  });

  it('detects 10.x.x.x private range', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
  });

  it('detects 172.16-31.x.x private range', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  it('detects 192.168.x.x private range', () => {
    expect(isPrivateHost('192.168.0.1')).toBe(true);
    expect(isPrivateHost('192.168.255.255')).toBe(true);
  });

  it('detects 169.254.x.x link-local / cloud metadata', () => {
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('169.254.0.1')).toBe(true);
  });

  it('detects 0.0.0.0/8', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true);
    expect(isPrivateHost('0.255.255.255')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('1.2.3.4')).toBe(false);
  });
});

describe('fetchUrlTool SSRF protection', () => {
  it('blocks localhost URLs (127.0.0.1)', async () => {
    const result = await fetchUrlTool('http://127.0.0.1/secret');
    expect(result.success).toBe(false);
    expect(result.error).toContain('internal/private network');
  });

  it('blocks private IPs (10.0.0.1)', async () => {
    const result = await fetchUrlTool('http://10.0.0.1/admin');
    expect(result.success).toBe(false);
    expect(result.error).toContain('internal/private network');
  });

  it('blocks IPv6 loopback (::1)', async () => {
    const result = await fetchUrlTool('http://[::1]/secret');
    expect(result.success).toBe(false);
    expect(result.error).toContain('internal/private network');
  });

  it('blocks cloud metadata (169.254.169.254)', async () => {
    const result = await fetchUrlTool('http://169.254.169.254/latest/meta-data/');
    expect(result.success).toBe(false);
    expect(result.error).toContain('internal/private network');
  });

  it('allows normal public URLs (may fail with network error, but not SSRF block)', async () => {
    const result = await fetchUrlTool('https://example.com');
    // Should NOT be blocked by SSRF check — it may fail for network reasons but error won't mention private network
    if (!result.success) {
      expect(result.error).not.toContain('internal/private network');
    }
  });
});
