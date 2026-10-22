// HTTP server: mounts every route table.
import { createServer as createHttpServer } from 'node:http';
import type { Config } from '../lib/config';
import { createLogger } from '../lib/logger';
import { routes } from './routes';

export function createServer(config: Config) {
  const log = createLogger(config.logLevel);
  return createHttpServer((req, res) => {
    log(`${req.method} ${req.url}`);
    const handler = routes[req.url ?? '/'];
    if (handler) handler(req, res);
    else res.writeHead(404).end();
  });
}
