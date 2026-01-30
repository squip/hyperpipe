import pino from 'pino';
import pinoHttp from 'pino-http';

function createLogger(options = {}) {
  return pino({
    level: 'trace',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
    ...options
  });
}

function createHttpLogger(logger) {
  return pinoHttp({
    logger,
    autoLogging: true,
    redact: ['req.headers.authorization', 'req.headers.cookie']
  });
}

export {
  createLogger,
  createHttpLogger
};
