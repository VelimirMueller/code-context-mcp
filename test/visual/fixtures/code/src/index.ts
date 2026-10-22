// Entry point: starts the HTTP server with the default routes.
import { createServer } from './api/server';
import { loadConfig } from './lib/config';

export function main(): void {
  const config = loadConfig();
  createServer(config).listen(config.port);
}
