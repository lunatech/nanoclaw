import http from 'http';
import { randomBytes } from 'crypto';

import { storeChatMetadata, storeMessage } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface InjectServerOpts {
  host: string;
  port: number;
  secret: string;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export function startInjectServer(opts: InjectServerOpts): void {
  const { host, port, secret, registeredGroups } = opts;

  const server = http.createServer((req, res) => {
    const sendJson = (status: number, body: object) => {
      const json = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      });
      res.end(json);
    };

    // Only accept POST /inject
    if (req.method !== 'POST' || req.url !== '/inject') {
      sendJson(404, { error: 'not found' });
      return;
    }

    // Validate Authorization header (Bearer token)
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      logger.warn(
        { ip: req.socket.remoteAddress },
        'Inject: unauthorized request',
      );
      sendJson(401, { error: 'unauthorized' });
      return;
    }

    // Read and parse body (64 KB limit)
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 65536) {
        req.destroy(new Error('request body too large'));
      }
    });

    req.on('end', () => {
      let data: { chatJid?: string; text?: string; senderName?: string };
      try {
        data = JSON.parse(body);
      } catch {
        sendJson(400, { error: 'invalid JSON' });
        return;
      }

      const { chatJid, text, senderName = 'inject' } = data;

      if (!chatJid || typeof chatJid !== 'string') {
        sendJson(400, { error: 'chatJid is required' });
        return;
      }
      if (!text || typeof text !== 'string') {
        sendJson(400, { error: 'text is required' });
        return;
      }

      // Only allow registered groups — prevents injecting into arbitrary chats
      const groups = registeredGroups();
      if (!groups[chatJid]) {
        sendJson(403, { error: `chatJid ${chatJid} is not registered` });
        return;
      }

      const timestamp = new Date().toISOString();
      const messageId = `inject-${randomBytes(6).toString('hex')}`;

      storeChatMetadata(chatJid, timestamp);
      storeMessage({
        id: messageId,
        chat_jid: chatJid,
        sender: 'inject',
        sender_name: senderName,
        content: text,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, senderName, messageId }, 'Inject: message queued');
      sendJson(200, { ok: true, messageId });
    });

    req.on('error', (err) => {
      logger.warn({ err }, 'Inject: request error');
    });
  });

  server.listen(port, host, () => {
    logger.info({ host, port }, 'Inject server listening');
    console.log(`  Inject endpoint: http://${host}:${port}/inject`);
    console.log(`  (Tailscale-only — set INJECT_HOST to your Tailscale IP)`);
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Inject server error');
  });
}
