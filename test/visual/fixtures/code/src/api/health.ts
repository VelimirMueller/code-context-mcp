// Health check handler.
import type { IncomingMessage, ServerResponse } from 'node:http';

export function health(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
}
