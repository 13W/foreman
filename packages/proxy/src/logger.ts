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

  if (format === 'pretty') {
    return pino(
      { level },
      pino.transport({ target: 'pino-pretty', options: { colorize: true, destination: dest } }),
    );
  }

  return pino({ level }, pino.destination(dest));
}

export const logger = createLogger();

export function configureLevel(level: LogLevel): void {
  logger.level = level;
}
