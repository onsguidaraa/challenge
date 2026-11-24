// Runs before every test file, before any application module is imported.
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused-in-tests';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-123';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-456';
process.env.ACCESS_TOKEN_TTL = '15m';
process.env.REFRESH_TOKEN_TTL = '7d';
// Existing tests expect learnedStats to be fresh after every event; debounce tests opt in explicitly.
process.env.LEARNED_STATS_MIN_INTERVAL_SECONDS = '0';
process.env.CORS_ORIGIN = 'http://localhost:5173';
