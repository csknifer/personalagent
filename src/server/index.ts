/**
 * Web server entry point — HTTP + WebSocket server for the web UI.
 * Serves static files from web/dist in production, provides REST API and WebSocket.
 */

import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

/** Returns true if filePath is inside (or equal to) dir, after resolving both. */
export function isPathInsideDir(filePath: string, dir: string): boolean {
  const resolvedPath = resolve(filePath);
  const resolvedDir = resolve(dir);
  return resolvedPath === resolvedDir || resolvedPath.startsWith(resolvedDir + sep);
}
import { WebSocketServer } from 'ws';
import { WebSocketHandler } from './WebSocketHandler.js';
import type { BootstrapResult } from '../bootstrap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ServerOptions {
  port?: number;
  host?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export async function startServer(
  bootstrap: BootstrapResult,
  options: ServerOptions = {}
): Promise<void> {
  const config = bootstrap.config;
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;

  // Resolve static directory for production serving
  const staticDir = config.server.staticDir
    ?? join(dirname(dirname(__dirname)), 'web', 'dist');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // CORS headers
    if (config.server.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // ─── REST API ─────────────────────────────────────────────

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        provider: config.hive.queen.provider || config.activeProvider,
        model: config.hive.queen.model || config.activeModel,
        workerProvider: config.hive.worker.provider || config.activeProvider,
        maxWorkers: config.hive.worker.maxConcurrent,
      }));
      return;
    }

    if (url.pathname === '/api/config') {
      // Sanitized config — no API keys
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        providers: {
          default: config.providers.default,
          available: Object.keys(config.providers).filter(k => k !== 'default'),
        },
        hive: {
          queen: {
            provider: config.hive.queen.provider,
            model: config.hive.queen.model,
          },
          worker: {
            provider: config.hive.worker.provider,
            model: config.hive.worker.model,
            maxConcurrent: config.hive.worker.maxConcurrent,
          },
          ralphLoop: {
            maxIterations: config.hive.ralphLoop.maxIterations,
            verificationStrategy: config.hive.ralphLoop.verificationStrategy,
          },
        },
        skills: { enabled: config.skills.enabled },
        mcp: { enabled: config.mcp.enabled, tools: config.mcp.tools },
      }));
      return;
    }

    // ─── MCP Protocol Endpoint ──────────────────────────────────

    if (bootstrap.mcpProtocolServer && config.mcp.expose?.enabled && config.mcp.expose.http?.enabled !== false) {
      const mcpPath = config.mcp.expose.http?.path ?? '/mcp';
      if (url.pathname === mcpPath) {
        try {
          await bootstrap.mcpProtocolServer.serveHTTP(req, res);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'MCP request failed' }));
          }
        }
        return;
      }
    }

    // ─── Static File Serving ──────────────────────────────────

    try {
      let filePath = join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname);

      // Guard against path traversal
      if (!isPathInsideDir(filePath, staticDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      // Check if file exists
      const fileStat = await stat(filePath).catch(() => null);

      // SPA fallback: serve index.html for non-file routes
      if (!fileStat || !fileStat.isFile()) {
        filePath = join(staticDir, 'index.html');
        const indexStat = await stat(filePath).catch(() => null);
        if (!indexStat) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
      }

      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = await readFile(filePath);

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  // ─── WebSocket Server ─────────────────────────────────────────

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const handler = new WebSocketHandler(ws, bootstrap);
    handler.start();
  });

  // ─── Shutdown ─────────────────────────────────────────────────

  bootstrap.shutdownManager.register('httpServer', () => {
    return new Promise<void>((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
      });
    });
  }, 5);

  // ─── Start Listening ──────────────────────────────────────────

  return new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      console.log(`\n\x1b[36m\u2728 Personal Agent Web UI\x1b[0m`);
      console.log(`\x1b[90m   Local:   \x1b[0mhttp://${host}:${port}`);
      if (host === 'localhost' || host === '127.0.0.1') {
        console.log(`\x1b[90m   Network: \x1b[0mhttp://0.0.0.0:${port}`);
      }
      console.log(`\x1b[90m   WS:      \x1b[0mws://${host}:${port}/ws`);
      if (bootstrap.mcpProtocolServer && config.mcp.expose?.enabled && config.mcp.expose.http?.enabled !== false) {
        const mcpPath = config.mcp.expose.http?.path ?? '/mcp';
        console.log(`\x1b[90m   MCP:     \x1b[0mhttp://${host}:${port}${mcpPath}`);
      }
      console.log(`\x1b[90m   Provider:\x1b[0m ${config.hive.queen.provider || config.activeProvider} / ${config.hive.queen.model || config.activeModel}`);
      console.log('');
      resolve();
    });
  });
}
