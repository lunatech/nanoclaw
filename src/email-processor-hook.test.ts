import { EventEmitter } from 'events';
import fs from 'fs';
import { PassThrough } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: any[]) => spawnMock(...args),
  };
});

import {
  getEmailProcessorScriptPath,
  runEmailProcessorForMessage,
  shouldRunEmailProcessor,
} from './email-processor-hook.js';

function createMockProcess(exitCode = 0) {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  return {
    proc,
    finish: () => {
      proc.emit('close', exitCode);
    },
  };
}

describe('email-processor-hook', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  it('runs only for main-group injected emails', () => {
    expect(
      shouldRunEmailProcessor(
        {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: 'x',
          isMain: true,
        },
        {
          id: '1',
          chat_jid: 'tg:1',
          sender: 'inject-email',
          sender_name: 'Mailbox',
          content: 'hello',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ),
    ).toBe(true);

    expect(
      shouldRunEmailProcessor(
        { name: 'Group', folder: 'group', trigger: '@Andy', added_at: 'x' },
        {
          id: '1',
          chat_jid: 'tg:1',
          sender: 'inject-email',
          sender_name: 'Mailbox',
          content: 'hello',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ),
    ).toBe(false);
  });

  it('pipes message content to the processor stdin', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const { proc, finish } = createMockProcess(0);
    spawnMock.mockReturnValue(proc);

    let written = '';
    proc.stdin.on('data', (chunk) => {
      written += chunk.toString();
    });

    const runPromise = runEmailProcessorForMessage(
      {
        name: 'Main',
        folder: 'main',
        trigger: '@Andy',
        added_at: 'x',
        isMain: true,
      },
      {
        id: 'msg-1',
        chat_jid: 'tg:1',
        sender: 'inject-email',
        sender_name: 'Mailbox',
        content: 'Forwarded email payload',
        timestamp: '2026-01-01T00:00:00Z',
      },
    );

    finish();
    await runPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      'python3',
      [
        getEmailProcessorScriptPath({
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: 'x',
          isMain: true,
        }),
      ],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(written).toBe('Forwarded email payload');
  });
});
