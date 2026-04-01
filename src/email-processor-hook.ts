import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { tryParseSingleUntrustedBlock } from './untrusted-content.js';

export function shouldRunEmailProcessor(
  group: RegisteredGroup | undefined,
  msg: NewMessage,
): boolean {
  return Boolean(
    group?.isMain && msg.sender === 'inject-email' && !msg.is_from_me,
  );
}

export function getEmailProcessorScriptPath(group: RegisteredGroup): string {
  return path.join(resolveGroupFolderPath(group.folder), 'email-processor.py');
}

function getJsonPayloadKeys(msg: NewMessage): {
  payloadKeys?: string[];
  decodedPayloadKeys?: string[];
  emailKeys?: string[];
} {
  const parsed = tryParseSingleUntrustedBlock(msg.content);
  if (!parsed) return {};

  try {
    const payload = JSON.parse(parsed.content) as Record<string, unknown>;
    const payloadKeys = Object.keys(payload);

    if (
      payload.type === 'encoded_forwarded_email' &&
      payload.encoding === 'base64-json' &&
      typeof payload.payload === 'string'
    ) {
      const decoded = JSON.parse(
        Buffer.from(payload.payload, 'base64').toString('utf-8'),
      ) as Record<string, unknown>;
      return {
        payloadKeys,
        decodedPayloadKeys: Object.keys(decoded),
        emailKeys:
          decoded.email &&
          typeof decoded.email === 'object' &&
          !Array.isArray(decoded.email)
            ? Object.keys(decoded.email as Record<string, unknown>)
            : undefined,
      };
    }

    return {
      payloadKeys,
      emailKeys:
        payload.email &&
        typeof payload.email === 'object' &&
        !Array.isArray(payload.email)
          ? Object.keys(payload.email as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return {};
  }
}

export async function runEmailProcessorForMessage(
  group: RegisteredGroup,
  msg: NewMessage,
): Promise<void> {
  const scriptPath = getEmailProcessorScriptPath(group);
  if (!fs.existsSync(scriptPath)) {
    logger.warn(
      { chatJid: msg.chat_jid, scriptPath },
      'Email processor script not found, skipping email ingestion',
    );
    return;
  }

  logger.info(
    {
      chatJid: msg.chat_jid,
      messageId: msg.id,
      contentLength: msg.content.length,
      ...getJsonPayloadKeys(msg),
    },
    'Email processor piping message content to stdin',
  );

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info(
          {
            chatJid: msg.chat_jid,
            messageId: msg.id,
            output: stdout.trim() || undefined,
          },
          'Email processor completed',
        );
        resolve();
        return;
      }

      reject(
        new Error(
          `email processor exited with code ${code}: ${(stderr || stdout).trim()}`,
        ),
      );
    });

    proc.stdin.write(msg.content);
    proc.stdin.end();
  });
}
