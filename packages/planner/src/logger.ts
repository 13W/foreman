import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFormat = 'json' | 'pretty';
export type LogDestination = 'stderr' | 'stdout';

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  destination: LogDestination;
}

export function createLogger(config?: Partial<LoggingConfig>): pino.Logger {
  const level = config?.level ?? 'info';
  const format = config?.format ?? 'json';
  const destination = config?.destination ?? 'stderr';

  const dest = destination === 'stdout' ? 1 : 2;

  // We don't have pino-pretty in deps, so we only support json for now
  // or we could add pino-pretty but let's stick to what's in package.json
  return pino({ level }, pino.destination(dest));
}

export const logger = createLogger();
