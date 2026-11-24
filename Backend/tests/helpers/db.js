import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../../src/config/db.js';

let mongod;

export const startTestDb = async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
  // Make sure unique indexes exist before the first test runs.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
};

export const clearTestDb = async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
};

export const stopTestDb = async () => {
  await disconnectDB();
  if (mongod) await mongod.stop();
};
