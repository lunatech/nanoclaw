import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

function isWithinBoundary(basePath: string, candidatePath: string): boolean {
  const rel = path.relative(basePath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeMoveToErrorDir(
  filePath: string,
  sourceGroup: string,
  file: string,
  canonicalSourceDir: string,
  canonicalErrorDir: string,
): void {
  try {
    const canonicalFilePath = fs.realpathSync(filePath);
    if (!isWithinBoundary(canonicalSourceDir, canonicalFilePath)) {
      logger.warn(
        { file, sourceGroup, filePath },
        'Rejected IPC file move outside canonical source directory',
      );
      return;
    }
    fs.renameSync(canonicalFilePath, path.join(canonicalErrorDir, `${sourceGroup}-${file}`));
  } catch (moveErr) {
    logger.error(
      { file, sourceGroup, err: moveErr },
      'Failed to move IPC file to errors directory',
    );
  }
}

export async function processGroupIpcFiles(
  sourceGroup: string,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
  ipcBaseDir: string,
): Promise<void> {
  const isMain = sourceGroup === MAIN_GROUP_FOLDER;
  let groupIpcRoot: string;
  try {
    groupIpcRoot = resolveGroupIpcPath(sourceGroup);
  } catch (err) {
    logger.warn({ sourceGroup, err }, 'Skipping invalid IPC group folder');
    return;
  }
  const expectedMessagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
  const expectedTasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

  const canonicalErrorDirExpected = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(canonicalErrorDirExpected, { recursive: true });
  const canonicalErrorDir = fs.realpathSync(canonicalErrorDirExpected);
  if (!isWithinBoundary(ipcBaseDir, canonicalErrorDir)) {
    logger.error({ sourceGroup, canonicalErrorDir }, 'IPC errors directory escaped IPC base');
    return;
  }

  let canonicalMessagesDir: string | null = null;
  let canonicalTasksDir: string | null = null;

  try {
    if (fs.existsSync(expectedMessagesDir)) {
      canonicalMessagesDir = fs.realpathSync(expectedMessagesDir);
      if (!isWithinBoundary(groupIpcRoot, canonicalMessagesDir)) {
        logger.warn(
          { sourceGroup, canonicalMessagesDir },
          'Rejected IPC messages directory outside group IPC root',
        );
        canonicalMessagesDir = null;
      }
    }

    if (fs.existsSync(expectedTasksDir)) {
      canonicalTasksDir = fs.realpathSync(expectedTasksDir);
      if (!isWithinBoundary(groupIpcRoot, canonicalTasksDir)) {
        logger.warn(
          { sourceGroup, canonicalTasksDir },
          'Rejected IPC tasks directory outside group IPC root',
        );
        canonicalTasksDir = null;
      }
    }
  } catch (err) {
    logger.error({ err, sourceGroup }, 'Error resolving canonical IPC group directories');
    return;
  }

  // Process messages from this group's IPC directory
  try {
    if (canonicalMessagesDir) {
      const messageFiles = fs
        .readdirSync(canonicalMessagesDir)
        .filter((f) => f.endsWith('.json'));
      for (const file of messageFiles) {
        const filePath = path.join(canonicalMessagesDir, file);
        let canonicalFilePath: string;
        try {
          const stat = fs.lstatSync(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            logger.warn({ file, sourceGroup }, 'Rejected non-regular IPC message file');
            continue;
          }

          canonicalFilePath = fs.realpathSync(filePath);
          if (!isWithinBoundary(canonicalMessagesDir, canonicalFilePath)) {
            logger.warn(
              { file, sourceGroup, canonicalFilePath },
              'Rejected IPC message file outside canonical messages directory',
            );
            continue;
          }

          const data = JSON.parse(fs.readFileSync(canonicalFilePath, 'utf-8'));
          if (data.type === 'message' && data.chatJid && data.text) {
            // Authorization: verify this group can send to this chatJid
            const targetGroup = registeredGroups[data.chatJid];
            if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
              await deps.sendMessage(data.chatJid, data.text);
              logger.info(
                { chatJid: data.chatJid, sourceGroup },
                'IPC message sent',
              );
            } else {
              logger.warn(
                { chatJid: data.chatJid, sourceGroup },
                'Unauthorized IPC message attempt blocked',
              );
            }
          }
          fs.unlinkSync(canonicalFilePath);
        } catch (err) {
          logger.error(
            { file, sourceGroup, err },
            'Error processing IPC message',
          );
          safeMoveToErrorDir(
            filePath,
            sourceGroup,
            file,
            canonicalMessagesDir,
            canonicalErrorDir,
          );
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, sourceGroup },
      'Error reading IPC messages directory',
    );
  }

  // Process tasks from this group's IPC directory
  try {
    if (canonicalTasksDir) {
      const taskFiles = fs
        .readdirSync(canonicalTasksDir)
        .filter((f) => f.endsWith('.json'));
      for (const file of taskFiles) {
        const filePath = path.join(canonicalTasksDir, file);
        try {
          const stat = fs.lstatSync(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            logger.warn({ file, sourceGroup }, 'Rejected non-regular IPC task file');
            continue;
          }

          const canonicalFilePath = fs.realpathSync(filePath);
          if (!isWithinBoundary(canonicalTasksDir, canonicalFilePath)) {
            logger.warn(
              { file, sourceGroup, canonicalFilePath },
              'Rejected IPC task file outside canonical tasks directory',
            );
            continue;
          }

          const data = JSON.parse(fs.readFileSync(canonicalFilePath, 'utf-8'));
          // Pass source group identity to processTaskIpc for authorization
          await processTaskIpc(data, sourceGroup, isMain, deps);
          fs.unlinkSync(canonicalFilePath);
        } catch (err) {
          logger.error(
            { file, sourceGroup, err },
            'Error processing IPC task',
          );
          safeMoveToErrorDir(
            filePath,
            sourceGroup,
            file,
            canonicalTasksDir,
            canonicalErrorDir,
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      await processGroupIpcFiles(sourceGroup, deps, registeredGroups, ipcBaseDir);
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
