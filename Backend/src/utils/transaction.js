import mongoose from 'mongoose';

const TRANSACTION_TOPOLOGIES = ['ReplicaSetWithPrimary', 'Sharded', 'LoadBalanced'];

/** MongoDB transactions need a replica set or sharded cluster (not a standalone server). */
export const supportsTransactions = () => {
  const type = mongoose.connection.getClient?.()?.topology?.description?.type;
  return TRANSACTION_TOPOLOGIES.includes(type);
};

/**
 * Runs `work(session)` inside a transaction when the deployment supports it,
 * otherwise runs `work(null)` without one. Pass the session to every query
 * (`{ session }` / `.session(session)`); a null session is a no-op in Mongoose.
 *
 * `work` may be retried by the driver on transient errors, so it must be idempotent.
 */
export const withOptionalTransaction = async (work) => {
  if (!supportsTransactions()) return work(null);
  return mongoose.connection.transaction((session) => work(session));
};
