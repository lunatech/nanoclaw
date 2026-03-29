import { readEnvFile } from '../env.js';

const envConfig = readEnvFile([
  'INJECT_SECRET',
  'INJECT_HOST',
  'INJECT_PORT',
  'CREDENTIAL_PROXY_PORT',
  'ONECLI_URL',
  'MAX_MESSAGES_PER_PROMPT',
]);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const forkConfig = {
  credentialProxyPort: parsePositiveInt(
    process.env.CREDENTIAL_PROXY_PORT || envConfig.CREDENTIAL_PROXY_PORT,
    3001,
  ),
  onecliUrl:
    process.env.ONECLI_URL ||
    envConfig.ONECLI_URL ||
    'http://localhost:10254',
  maxMessagesPerPrompt: parsePositiveInt(
    process.env.MAX_MESSAGES_PER_PROMPT || envConfig.MAX_MESSAGES_PER_PROMPT,
    10,
  ),
  inject: {
    secret: process.env.INJECT_SECRET || envConfig.INJECT_SECRET || '',
    host: process.env.INJECT_HOST || envConfig.INJECT_HOST || '127.0.0.1',
    port: parsePositiveInt(
      process.env.INJECT_PORT || envConfig.INJECT_PORT,
      3721,
    ),
  },
};
