import { env } from '../config/env.js';

const silent = env.isTest;

const log = (level, args) => {
  if (silent) return;
  console[level](`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
};

export const logger = {
  info: (...args) => log('info', args),
  warn: (...args) => log('warn', args),
  error: (...args) => log('error', args),
};
