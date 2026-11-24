import app from './app.js';
import { env } from './config/env.js';
import { connectDB, registerGracefulShutdown } from './config/db.js';
import { logger } from './utils/logger.js';

const start = async () => {
  await connectDB();
  const server = app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
  });
  registerGracefulShutdown(server);
};

start().catch((err) => {
  logger.error('Failed to start server:', err.message);
  process.exit(1);
});
