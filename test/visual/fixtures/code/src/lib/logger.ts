// Small structured logger.
import type { Config } from './config';

export function createLogger(level: Config['logLevel']) {
  return (msg: string) => {
    if (level !== 'warn') process.stdout.write(`${msg}\n`);
  };
}
