import {
  Injectable,
  LoggerService as NestLoggerService,
  Scope,
} from '@nestjs/common';
import { createLogger, format, transports, Logger } from 'winston';
import { CONFIG } from '../constants/config.constants';

@Injectable({ scope: Scope.TRANSIENT })
export class LoggerService implements NestLoggerService {
  private readonly logger: Logger;
  private readonly context?: string;

  constructor(context?: string) {
    this.context = context;
    this.logger = this.createWinstonLogger();
  }

  private createWinstonLogger(): Logger {
    const baseTransports: any[] = [
      new transports.Console({
        level: process.env.LOG_LEVEL || CONFIG.APP.DEFAULT_LOG_LEVEL,
        format: format.combine(
          format.colorize(),
          format.printf(({ timestamp, level, message, context, ...meta }) => {
            const formattedTimestamp =
              timestamp instanceof Date
                ? timestamp.toISOString()
                : String(timestamp);
            const formattedContext =
              typeof context === 'string' ? context : 'App';
            const formattedMessage =
              typeof message === 'string'
                ? message
                : typeof message === 'object' && message !== null
                  ? JSON.stringify(message)
                  : String(message);

            return `${formattedTimestamp} [${formattedContext}] ${String(level)}: ${formattedMessage}${
              Object.keys(meta).length
                ? ' ' + JSON.stringify(meta, null, 1)
                : ''
            }`;
          }),
        ),
      }),
    ];

    // Add file transports conditionally based on environment
    const shouldEnableFileLogging = this.shouldEnableFileLogging();
    if (shouldEnableFileLogging) {
      try {
        baseTransports.push(
          new transports.File({
            filename: `${process.env.LOG_DIR || CONFIG.APP.DEFAULT_LOG_DIR}/error.log`,
            level: 'error',
          }),
          new transports.File({
            filename: `${process.env.LOG_DIR || CONFIG.APP.DEFAULT_LOG_DIR}/combined.log`,
          }),
        );
      } catch (error) {
        // If file transport creation fails (e.g., read-only filesystem),
        // log a warning but continue with console-only logging
        console.warn(
          'Failed to initialize file transports, falling back to console-only logging:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return createLogger({
      format: format.combine(
        format.timestamp(),
        format.errors({ stack: true }),
        format.json(),
      ),
      defaultMeta: { context: this.context },
      transports: baseTransports,
    });
  }

  /**
   * Determines whether file logging should be enabled based on environment configuration
   */
  private shouldEnableFileLogging(): boolean {
    const nodeEnv = process.env.NODE_ENV;
    const enableFileLogging = process.env.ENABLE_FILE_LOGGING;

    // In production, only enable file logging if explicitly requested
    if (nodeEnv === 'production') {
      return enableFileLogging === 'true';
    }

    // In non-production environments (development, test), enable file logging by default
    // unless explicitly disabled
    return enableFileLogging !== 'false';
  }

  private formatMessage(message: unknown): string {
    if (typeof message === 'string') {
      return message;
    }
    if (typeof message === 'object' && message !== null) {
      return JSON.stringify(message);
    }
    return String(message);
  }

  error(message: unknown, meta?: Record<string, unknown>): void {
    this.logger.error(this.formatMessage(message), meta);
  }

  warn(message: unknown, meta?: Record<string, unknown>): void {
    this.logger.warn(this.formatMessage(message), meta);
  }

  info(message: unknown, meta?: Record<string, unknown>): void {
    this.logger.info(this.formatMessage(message), meta);
  }

  debug(message: unknown, meta?: Record<string, unknown>): void {
    this.logger.debug(this.formatMessage(message), meta);
  }

  verbose(message: unknown, meta?: Record<string, unknown>): void {
    this.logger.verbose(this.formatMessage(message), meta);
  }

  log(message: unknown, meta?: Record<string, unknown>): void {
    this.info(message, meta);
  }
}
