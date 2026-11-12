import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectContext } from './types.js';

export interface DeriveProjectRootsInput {
  cwd: string;
  explicitProjectRoot?: string;
  gitShowTopLevel?: string;
  gitCommonDir?: string;
}

export interface DerivedProjectRoots {
  contentRoot: string;
  memoryKeyRoot: string;
}

interface GitPaths {
  showTopLevel?: string;
  commonDir?: string;
}

function normalizeGitPath(baseDir: string, value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseDir, trimmed);
}

export function slugifyClaudeProjectPath(projectPath: string): string {
  const normalized = resolve(projectPath).replace(/^[a-zA-Z]:/, '').replace(/\\/g, '/');
  return normalized.replace(/\//g, '-') || 'project';
}

export function deriveProjectRoots(input: DeriveProjectRootsInput): DerivedProjectRoots {
  const cwd = resolve(input.cwd);
  const contentRoot = resolve(input.explicitProjectRoot ?? input.gitShowTopLevel ?? cwd);

  if (input.gitCommonDir) {
    const commonDir = resolve(input.gitCommonDir);
    if (commonDir.endsWith('/.git') || commonDir.endsWith('\\.git')) {
      return {
        contentRoot,
        memoryKeyRoot: dirname(commonDir),
      };
    }
  }

  return {
    contentRoot,
    memoryKeyRoot: resolve(input.gitShowTopLevel ?? contentRoot),
  };
}

export function readGitPaths(startDir: string): GitPaths {
  const git: GitPaths = {};

  try {
    git.showTopLevel = normalizeGitPath(
      startDir,
      execFileSync('git', ['-C', startDir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {}

  try {
    git.commonDir = normalizeGitPath(
      startDir,
      execFileSync('git', ['-C', startDir, 'rev-parse', '--git-common-dir'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {}

  return git;
}

export function resolveProjectContext(opts: {
  homeDir: string;
  cwd?: string;
  projectRoot?: string;
}): ProjectContext {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const explicitProjectRoot = opts.projectRoot ? resolve(opts.projectRoot) : undefined;
  const gitPaths = readGitPaths(explicitProjectRoot ?? cwd);
  const roots = deriveProjectRoots({
    cwd,
    explicitProjectRoot,
    gitShowTopLevel: gitPaths.showTopLevel,
    gitCommonDir: gitPaths.commonDir,
  });

  const homeDir = resolve(opts.homeDir);
  const projectSlug = slugifyClaudeProjectPath(roots.memoryKeyRoot);

  return {
    homeDir,
    contentRoot: roots.contentRoot,
    memoryKeyRoot: roots.memoryKeyRoot,
    projectSlug,
    memoryDir: join(homeDir, '.claude', 'projects', projectSlug, 'memory'),
    backupBaseDir: join(homeDir, '.claude', 'projects', projectSlug, '.openrind-shell-memory-backups'),
  };
}
