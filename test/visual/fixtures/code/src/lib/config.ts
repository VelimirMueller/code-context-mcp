// Runtime configuration from environment variables.
export interface Config {
  port: number;
  logLevel: 'debug' | 'info' | 'warn';
}

export function loadConfig(): Config {
  return { port: Number(process.env.PORT ?? 8080), logLevel: 'info' };
}
