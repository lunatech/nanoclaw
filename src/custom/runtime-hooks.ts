import http from 'http';

import { startInjectServer } from '../inject-server.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';

import { forkConfig } from './config.js';

export interface RuntimeHooksContext {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface RuntimeServiceHandle {
  close(): Promise<void>;
}

function wrapServer(server: http.Server): RuntimeServiceHandle {
  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

export function startCustomServices(
  context: RuntimeHooksContext,
): RuntimeServiceHandle[] {
  if (!forkConfig.inject.secret) {
    logger.debug('INJECT_SECRET not set — inject endpoint disabled');
    return [];
  }

  const server = startInjectServer({
    host: forkConfig.inject.host,
    port: forkConfig.inject.port,
    secret: forkConfig.inject.secret,
    registeredGroups: context.registeredGroups,
  });
  return [wrapServer(server)];
}

export async function stopCustomServices(
  services: RuntimeServiceHandle[],
): Promise<void> {
  await Promise.all(services.map((service) => service.close()));
}
