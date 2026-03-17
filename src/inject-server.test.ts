import http from 'http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getMessagesSince,
  setRegisteredGroup,
} from './db.js';
import { startInjectServer } from './inject-server.js';

describe('inject server', () => {
  let server: http.Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    _initTestDatabase();
    setRegisteredGroup('group@g.us', {
      name: 'Group',
      folder: 'group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    server = startInjectServer({
      host: '127.0.0.1',
      port: 0,
      secret: 'secret',
      registeredGroups: () => ({
        'group@g.us': {
          name: 'Group',
          folder: 'group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    });
    await new Promise<void>((resolve) => {
      server!.once('listening', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server did not bind to a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    server = null;
  });

  it('accepts legacy /inject requests', async () => {
    const response = await fetch(`${baseUrl}/inject`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chatJid: 'group@g.us', text: 'hello' }),
    });

    expect(response.status).toBe(200);
    const messages = getMessagesSince('group@g.us', '', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello');
  });

  it('accepts wrapped email content on /inject/email', async () => {
    const response = await fetch(`${baseUrl}/inject/email`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatJid: 'group@g.us',
        senderName: 'Mailbox',
        messageId: '<id@example.com>',
        wrappedEmail: '<untrusted>From: a@example.com\n\nhello</untrusted>',
      }),
    });

    expect(response.status).toBe(200);
    const messages = getMessagesSince('group@g.us', '', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('inject-email');
    expect(messages[0].content).toContain('Forwarded email.');
    expect(messages[0].content).toContain('<untrusted>From: a@example.com');
  });

  it('rejects email requests without wrapped content', async () => {
    const response = await fetch(`${baseUrl}/inject/email`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatJid: 'group@g.us',
        wrappedEmail: 'hello',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'missing opening untrusted marker',
    });
  });
});
