// Route table: path to handler.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { health } from './health';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export const routes: Record<string, Handler> = {
  '/health': health,
};
