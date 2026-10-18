'use strict';
/**
 * 清理构建与运行过程中产生的临时文件。
 *
 *   node scripts/clean.mjs          只清构建产物与临时文件
 *   node scripts/clean.mjs --data   连运行期数据一起清（配置、记忆、情绪、日志都会被删）
 *
 * 默认不动 runtime\models 与 runtime\data，避免删掉你下载好的语音组件和聊天记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withData = process.argv.includes('--data');

const targets = [
  'dist',
  'runtime/app-out.log',
  'runtime/app-err.log',
  'runtime/app-run.log',
  'runtime/diag.txt',
  'runtime/fetch-live2d.log',
  'runtime/npm-install.log',
];

if (withData) targets.push('runtime/data');

// 下载了一半的压缩包（electron-builder / 手工下载的残留）
const runtimeDir = path.join(root, 'runtime');
if (fs.existsSync(runtimeDir)) {
  for (const name of fs.readdirSync(runtimeDir)) {
    if (/\.(zip|tmp|part|download)$/i.test(name)) targets.push(path.join('runtime', name));
  }
}

let removed = 0;
for (const rel of targets) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  fs.rmSync(abs, { recursive: true, force: true });
  console.log('已删除 ' + rel);
  removed++;
}
console.log(removed ? `共清理 ${removed} 项。` : '没有需要清理的东西。');
if (!withData) console.log('（runtime\\data 与 runtime\\models 保留；加 --data 才会一起删）');
