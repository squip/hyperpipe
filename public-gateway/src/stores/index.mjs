import MemoryRegistrationStore from './MemoryRegistrationStore.mjs';
import RedisRegistrationStore from './RedisRegistrationStore.mjs';
import MemoryGatewayAdminStateStore from './MemoryGatewayAdminStateStore.mjs';
import RedisGatewayAdminStateStore from './RedisGatewayAdminStateStore.mjs';

async function createRegistrationStore(config = {}, logger) {
  if (config?.redisUrl) {
    try {
      const store = new RedisRegistrationStore({
        url: config.redisUrl,
        ttlSeconds: config.cacheTtlSeconds,
        relayTtlSeconds: config.relayTtlSeconds,
        aliasTtlSeconds: config.aliasTtlSeconds,
        tokenTtlSeconds: config.tokenTtlSeconds,
        mirrorTtlSeconds: config.mirrorTtlSeconds,
        openJoinPoolTtlSeconds: config.openJoinPoolTtlSeconds,
        prefix: config.redisPrefix,
        logger
      });
      await store.connect();
      logger?.info?.('Using Redis registration store');
      return store;
    } catch (error) {
      logger?.error?.('Failed to initialize Redis registration store, falling back to memory cache', { error: error.message });
    }
  }

  return new MemoryRegistrationStore({
    ttlSeconds: config?.cacheTtlSeconds,
    relayTtlSeconds: config?.relayTtlSeconds,
    aliasTtlSeconds: config?.aliasTtlSeconds,
    tokenTtlSeconds: config?.tokenTtlSeconds,
    mirrorTtlSeconds: config?.mirrorTtlSeconds,
    openJoinPoolTtlSeconds: config?.openJoinPoolTtlSeconds
  });
}

async function createGatewayAdminStateStore(config = {}, logger) {
  if (config?.redisUrl) {
    try {
      const store = new RedisGatewayAdminStateStore({
        url: config.redisUrl,
        prefix: config.adminStateRedisPrefix,
        activityRetention: config.adminActivityRetention,
        logger
      });
      await store.connect();
      logger?.info?.('Using Redis gateway admin state store');
      return store;
    } catch (error) {
      logger?.error?.('Failed to initialize Redis gateway admin state store, falling back to memory cache', {
        error: error?.message || error
      });
    }
  }

  return new MemoryGatewayAdminStateStore({
    activityRetention: config?.adminActivityRetention
  });
}

export {
  createRegistrationStore,
  createGatewayAdminStateStore
};
