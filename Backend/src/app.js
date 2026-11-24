import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { globalLimiter } from './middleware/rateLimiters.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { ApiError } from './utils/ApiError.js';

const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN }));
app.use((req, res, next) => {
  req.id = req.get('x-request-id')?.slice(0, 128) || randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use((req, _res, next) => {
  const containsOperator = (value) => {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(
      ([key, child]) => key.startsWith('$') || key.includes('.') || containsOperator(child),
    );
  };
  if (containsOperator(req.body)) {
    return next(ApiError.badRequest('MongoDB operators are not allowed in request data'));
  }
  next();
});

if (!env.isTest) {
  app.use(morgan(env.isProduction ? 'combined' : 'dev'));
}

app.use(globalLimiter);

app.use('/api/v1', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
