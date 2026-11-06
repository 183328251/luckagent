import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrintData, ReimbursementPrintConfig } from './types.js';
import { PrintError } from './types.js';

export interface RenderedFile {
  filePath: string;
  cleanup(): Promise<void>;
}
export type PdfRenderer = (data: PrintData) => Promise<RenderedFile>;
export function createRenderer(config: ReimbursementPrintConfig, workspace: string): PdfRenderer {
  const template = path.resolve(workspace, config.templatePath || 'reimbursement-print/template.xlsx');
  const script = fileURLToPath(new URL('../../../scripts/reimbursement-print/render.py', import.meta.url));
  return async (data) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'luckagent-reimbursement-'));
    try {
      const input = path.join(dir, 'data.json');
      const output = path.join(dir, '报销单.pdf');
      await writeFile(input, JSON.stringify(data), { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        execFile(
          config.pythonPath || 'python3',
          [
            script,
            '--template',
            template,
            '--data',
            input,
            '--output',
            output,
            ...(config.fontPath ? ['--font', config.fontPath] : []),
          ],
          { timeout: 60_000, maxBuffer: 1024 * 1024 },
          (error) => (error ? reject(error) : resolve()),
        );
      });
      if ((await stat(output)).size === 0) throw new Error('empty');
      return { filePath: output, cleanup: () => rm(dir, { recursive: true, force: true }) };
    } catch {
      await rm(dir, { recursive: true, force: true });
      throw new PrintError('PDF 生成失败，请联系管理员检查模板和打印环境。', 'pdf');
    }
  };
}
