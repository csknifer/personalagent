/**
 * Tests for htmlToText DOM-aware extraction.
 */

import { describe, it, expect } from 'vitest';
import { htmlToText } from './webSearch.js';

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
