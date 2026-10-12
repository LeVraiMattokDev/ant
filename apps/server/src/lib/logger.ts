import pino from 'pino';
import { redactString } from '@ant/shared';
import { secretValues } from '../config';

const secrets = secretValues();

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.ANT_SERVICE ?? 'ant' },
  hooks: {
    logMethod(args, method) {
      const cleaned = args.map((a) => (typeof a === 'string' ? redactString(a, secrets) : a)) as typeof args;
      method.apply(this, cleaned);
    },
  },
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.token', '*.apiKey'],
    censor: '[secret]',
  },
});

export type Logger = typeof logger;
