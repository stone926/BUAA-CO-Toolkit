// @index hazard-report-store — 本机版本化报告的有界读取、原子保存和最近报告发现
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_HAZARD_DIR } from '../constants';
import { sanitizeFileStem } from '../pathUtils';
import { readBoundedRegularFile } from '../mips/replay/boundedFile';
import { writeFileAtomicReplace } from '../mips/replay/atomicFile';
import type { HazardReport } from '../hazardAnalysis/reportTypes';
import { isHazardReport } from './reportValidation';
import { isHazardInput } from './input';

export interface SavedHazardReport {
  readonly format: 'buaa-co-hazard';
  readonly version: 1;
  readonly sourceUri: string;
  readonly sourceLabel: string;
  readonly createdAt: string;
  readonly report: HazardReport;
}

export async function saveHazardReport(folder: vscode.WorkspaceFolder, saved: SavedHazardReport): Promise<vscode.Uri> {
  const id = crypto.createHash('sha256').update(saved.sourceUri).digest('hex').slice(0, 16);
  const stem = sanitizeFileStem(path.parse(vscode.Uri.parse(saved.sourceUri).fsPath).name).slice(0, 48);
  const uri = vscode.Uri.joinPath(folder.uri, CO_HAZARD_DIR, `${stem}-${id}-hazard.json`);
  await writeFileAtomicReplace(uri.fsPath, Buffer.from(JSON.stringify(saved, null, 2) + '\n'));
  return uri;
}

export async function readHazardReport(uri: vscode.Uri): Promise<SavedHazardReport> {
  const bytes = await readBoundedRegularFile(uri.fsPath, { maximumBytes: 4 * 1024 * 1024, label: '冲突报告（最大 4 MiB）' });
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('所选冲突报告不是有效的 JSON'); }
  if (!isSavedHazardReport(value)) {
    throw new Error('不支持此报告格式或报告已损坏。请选择内置分析生成的 *-hazard.json，旧版报告请重新分析原始程序');
  }
  return value;
}

function isSavedHazardReport(value: unknown): value is SavedHazardReport {
  if (!value || typeof value !== 'object') return false;
  const saved = value as Partial<SavedHazardReport>;
  if (saved.format !== 'buaa-co-hazard' || saved.version !== 1
    || typeof saved.sourceUri !== 'string' || saved.sourceUri.length > 8192
    || typeof saved.sourceLabel !== 'string' || saved.sourceLabel.length > 4096
    || typeof saved.createdAt !== 'string' || saved.createdAt.length > 64 || !Number.isFinite(Date.parse(saved.createdAt))
    || !isHazardReport(saved.report)) return false;
  try { return isHazardInput(vscode.Uri.parse(saved.sourceUri, true)); }
  catch { return false; }
}

export async function recentHazardReports(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
  const directory = path.join(folder.uri.fsPath, CO_HAZARD_DIR);
  try {
    const entries = (await fs.promises.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('-hazard.json')).slice(0, 1000);
    const reports = await Promise.all(entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      try { return { file, time: (await fs.promises.stat(file)).mtimeMs }; } catch { return undefined; }
    }));
    return reports.filter((item): item is { file: string; time: number } => !!item)
      .sort((a, b) => b.time - a.time).slice(0, 50).map((item) => vscode.Uri.file(item.file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
