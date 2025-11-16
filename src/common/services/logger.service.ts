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

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    if (message instanceof Error) {
      return message.stack || message.message || message.name;
    }
    if (typeof message === 'string') {
      return message;
    }
    if (typeof message === 'object' && message !== null) {
      return JSON.stringify(message);
    }
    return String(message);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logMessage('error', message, optionalParams, true);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logMessage('warn', message, optionalParams);
  }

  info(message: unknown, ...optionalParams: unknown[]): void {
    this.logMessage('info', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logMessage('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logMessage('verbose', message, optionalParams);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logMessage('info', message, optionalParams);
  }

  private logMessage(
    level: 'error' | 'warn' | 'info' | 'debug' | 'verbose',
    message: unknown,
    optionalParams: unknown[],
    allowTrace = false,
  ): void {
    const { contextOverride, meta, trace } = this.extractLogOptions(
      optionalParams,
      allowTrace,
    );
    const context = contextOverride ?? this.context ?? 'App';
    const payload: Record<string, unknown> = {
      ...(meta ?? {}),
      context,
    };

    if (trace) {
      payload.trace = trace;
    }

    this.logger.log({
      level,
      message: this.formatMessage(message),
      ...payload,
    });
  }

  private extractLogOptions(
    optionalParams: unknown[],
    allowTrace: boolean,
  ): {
    contextOverride?: string;
    meta?: Record<string, unknown>;
    trace?: string;
  } {
    let trace: string | undefined;
    const remainingParams: unknown[] = [];

    optionalParams.forEach((param, index) => {
      if (
        allowTrace &&
        trace === undefined &&
        typeof param === 'string' &&
        (param.includes('\n') ||
          (index < optionalParams.length - 1 &&
            typeof optionalParams[index + 1] === 'string'))
      ) {
        trace = param;
      } else {
        remainingParams.push(param);
      }
    });

    let contextOverride: string | undefined;
    let meta: Record<string, unknown> | undefined;

    for (const param of remainingParams) {
      if (typeof param === 'string' && contextOverride === undefined) {
        contextOverride = param;
        continue;
      }

      if (this.isRecord(param) && meta === undefined) {
        meta = param;
        continue;
      }

      if (param instanceof Error && meta === undefined) {
        meta = { error: param.stack ?? param.message };
      }
    }

    return { contextOverride, meta, trace };
  }
}
