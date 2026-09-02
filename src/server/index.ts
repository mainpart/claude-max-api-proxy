/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { handleChatCompletions, handleModels, handleHealth } from "./routes.js";
import type { ConfigLayer, ProxyConfig } from "../config.js";
import { resolveConfig } from "../config.js";

/**
 * Overrides accepted by {@link startServer}. Anything omitted falls back to
 * the config file, the environment, and finally the built-in defaults.
 */
export type ServerConfig = ConfigLayer;

let serverInstance: Server | null = null;

/**
 * Status an error asks for. `body-parser` tags its own errors with the status
 * the client deserves (413 for an oversized body, 400 for an aborted request);
 * everything else is a proxy failure and stays a 500.
 */
function statusOf(err: Error): number {
  const status = (err as { status?: unknown; statusCode?: unknown }).status
    ?? (err as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) return status;
  return 500;
}

/**
 * Create and configure the Express app
 */
function createApp(config: ProxyConfig): Express {
  const app = express();

  // Middleware: use raw body parser + manual JSON parse for better error diagnostics
  app.use(express.raw({ type: "application/json", limit: "10mb" }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      const raw = req.body.toString("utf8");
      if (process.env.DEBUG) {
        console.log("[Body raw]:", raw.substring(0, 200));
      }
      try {
        req.body = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Body parse error]:", msg);
        if (process.env.DEBUG) {
          console.error("[Body raw]:", raw.substring(0, 300));
        } else {
          console.error("[Body metadata]:", {
            length: raw.length,
            method: req.method,
            url: req.originalUrl,
          });
        }
        res.status(400).json({
          error: {
            message: `Invalid JSON in request body: ${msg}`,
            type: "invalid_request_error",
            code: "invalid_json",
          },
        });
        return;
      }
    }
    next();
  });

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS headers for local development
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  // Handle OPTIONS preflight
  app.options("*", (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  // Routes
  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", (req: Request, res: Response) =>
    handleChatCompletions(req, res, config)
  );

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler. Errors that reach it carry their own status when the client
  // is at fault: body-parser throws 413 for an oversized body and 400 for an
  // aborted request. Anything without a 4xx status is ours, and stays a 500.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    const status = statusOf(err);
    res.status(status).json({
      error: {
        message: err.message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code: null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(overrides: ServerConfig = {}): Promise<Server> {
  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const config = resolveConfig({ overrides });
  const { port, host } = config;

  const app = createApp(config);

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
