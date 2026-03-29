import fs from 'fs';
import path from 'path';

export interface ContainerMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface SyncCustomWorkspaceOptions {
  dataDir: string;
  groupFolder: string;
  groupSessionsDir: string;
  projectRoot: string;
}

export interface ApplyCustomContainerEnvOptions {
  authMode: 'api-key' | 'oauth';
  credentialProxyPort: number;
  hostGateway: string;
}

export interface ApplyCustomMountsOptions {
  groupFolder: string;
  isMain: boolean;
}

export function syncCustomWorkspace(
  options: SyncCustomWorkspaceOptions,
): string {
  const { dataDir, groupFolder, groupSessionsDir, projectRoot } = options;
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    dataDir,
    'sessions',
    groupFolder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }

  return groupAgentRunnerDir;
}

export function applyCustomContainerEnv(
  args: string[],
  options: ApplyCustomContainerEnvOptions,
): void {
  const { authMode, credentialProxyPort, hostGateway } = options;
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${hostGateway}:${credentialProxyPort}`,
  );
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }
}

export function applyCustomMounts(
  mounts: ContainerMount[],
  _options: ApplyCustomMountsOptions,
): ContainerMount[] {
  return mounts;
}
