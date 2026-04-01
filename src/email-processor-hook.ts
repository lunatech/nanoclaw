import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

export function shouldRunEmailProcessor(
  group: RegisteredGroup | undefined,
  msg: NewMessage,
): boolean {
  return Boolean(group?.isMain && msg.sender === 'inject-email' && !msg.is_from_me);
}

export function getEmailProcessorScriptPath(group: RegisteredGroup): string {
  return path.join(resolveGroupFolderPath(group.folder), 'email-processor.py');
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
      contentPreview: msg.content.slice(0, 200),
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
