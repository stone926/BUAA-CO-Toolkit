import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getProfile, getTutorialRoot } from './config';
import {
  CourseTutorialLink,
  getCourseConfig,
  getProfileRequiredTools
} from './courseConfig';
import { ProjectProfile } from './projectProfile';

export function registerCourseLinks(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.course.openTutorial', () => openCourseTutorial()),
    vscode.commands.registerCommand('co.course.openProfileTutorial', (profile?: ProjectProfile) => openProfileTutorial(profile)),
    vscode.commands.registerCommand('co.course.openTutorialLink', (link?: CourseTutorialLink) => openTutorialLink(link))
  );
}

export function getProfileTutorialLink(profile: ProjectProfile): CourseTutorialLink | undefined {
  if (profile === 'auto') {
    return undefined;
  }
  return getCourseConfig().tutorial?.profiles?.[profile];
}

export function getToolTutorialLinksForProfile(profile: ProjectProfile): CourseTutorialLink[] {
  const tools = getCourseConfig().tutorial?.tools ?? {};
  const keys = relevantTutorialToolKeys(profile);
  return keys.flatMap((key) => tools[key] ?? []);
}

export async function openCourseTutorial(resource = vscode.window.activeTextEditor?.document.uri): Promise<void> {
  await openTutorialLink({ title: '课程教程首页', path: '' }, resource);
}

export async function openProfileTutorial(
  profile = getProfile(vscode.window.activeTextEditor?.document.uri),
  resource = vscode.window.activeTextEditor?.document.uri
): Promise<void> {
  const link = getProfileTutorialLink(profile);
  if (link) {
    await openTutorialLink(link, resource);
    return;
  }
  await openCourseTutorial(resource);
}

export async function openTutorialLink(
  link?: CourseTutorialLink,
  resource = vscode.window.activeTextEditor?.document.uri
): Promise<void> {
  const uri = resolveTutorialUri(link?.path ?? '', resource);
  await vscode.env.openExternal(uri);
}

export function resolveTutorialUri(linkPath: string, resource?: vscode.Uri): vscode.Uri {
  const root = tutorialRoot(resource);
  if (isHttpRoot(root)) {
    const { pathPart, fragment } = splitLinkPath(linkPath);
    const url = new URL(pathPart || '.', ensureTrailingSlash(root));
    if (fragment) {
      url.hash = fragment;
    }
    return vscode.Uri.parse(url.toString());
  }

  const localRoot = root.startsWith('file:')
    ? vscode.Uri.parse(root).fsPath
    : root;
  const { pathPart, fragment } = splitLinkPath(linkPath);
  const localPath = localTutorialPath(localRoot, pathPart);
  return vscode.Uri.file(localPath).with({ fragment });
}

function tutorialRoot(resource?: vscode.Uri): string {
  const configured = getTutorialRoot(resource);
  if (configured) {
    return configured;
  }
  return findLocalTutorialRoot() ?? getCourseConfig().tutorial?.officialRoot ?? 'https://cscore.buaa.edu.cn/';
}

function relevantTutorialToolKeys(profile: ProjectProfile): string[] {
  if (profile === 'auto') {
    return ['logisim', 'mars', 'ise'];
  }
  const requiredTools = new Set(getProfileRequiredTools(profile).map((tool) => tool.toLowerCase()));
  const keys: string[] = [];
  if (requiredTools.has('logisim')) {
    keys.push('logisim');
  }
  if (requiredTools.has('mars') || requiredTools.has('marsp7')) {
    keys.push('mars');
  }
  if (requiredTools.has('ise')) {
    keys.push('ise');
  }
  return keys;
}

function findLocalTutorialRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates: string[] = [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    candidates.push(
      path.resolve(root, 'cscore', 'site', 'cscore.buaa.edu.cn', 'tutorial'),
      path.resolve(root, '..', 'cscore', 'site', 'cscore.buaa.edu.cn', 'tutorial'),
      path.resolve(root, '..', '..', 'cscore', 'site', 'cscore.buaa.edu.cn', 'tutorial')
    );
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return undefined;
}

function localTutorialPath(root: string, linkPath: string): string {
  const cleanPath = linkPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = cleanPath ? cleanPath.split(/[\\/]+/) : [];
  const target = parts.length ? path.join(root, ...parts) : root;
  return path.extname(target) ? target : path.join(target, 'index.html');
}

function splitLinkPath(linkPath: string): { pathPart: string; fragment: string } {
  const hashIndex = linkPath.indexOf('#');
  if (hashIndex < 0) {
    return { pathPart: linkPath, fragment: '' };
  }
  return {
    pathPart: linkPath.slice(0, hashIndex),
    fragment: linkPath.slice(hashIndex + 1)
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isHttpRoot(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
