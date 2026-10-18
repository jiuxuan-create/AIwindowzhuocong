// 拉取 Live2D 官方免费示例模型（CubismWebSamples/Haru）与 Cubism Core 运行时。
// 素材版权归 Live2D Inc. 所有，按 Live2D Free Material License Agreement 使用，
// 许可原文见 docs/THIRD-PARTY-NOTICES.md。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const REPO = 'Live2D/CubismWebSamples';
const REF = 'develop';
const MODEL = process.env.PET_LIVE2D_MODEL || 'Haru';
const SUB = `Samples/Resources/${MODEL}`;
const OUT_MODEL = path.join(ROOT, 'app', 'assets', 'live2d', MODEL);
const OUT_VENDOR = path.join(ROOT, 'app', 'renderer', 'pet', 'vendor');

const UA = { 'User-Agent': 'xiaoman-pet-setup' };
const CUBISM_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

function human(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

async function withRetry(fn, label, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries) {
        const wait = 800 * i;
        console.warn(`  [retry ${i}/${tries - 1}] ${label}: ${err.message}，${wait}ms 后重试`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw new Error(`${label} 失败: ${lastErr && lastErr.message}`);
}

async function download(url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return buf.length;
}

async function listModelFiles() {
  const api = `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`;
  const res = await fetch(api, { headers: UA });
  if (!res.ok) throw new Error(`GitHub tree API HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.tree)) throw new Error('GitHub tree API 返回格式异常');
  return json.tree
    .filter((n) => n.type === 'blob' && n.path.startsWith(SUB + '/'))
    .map((n) => ({ path: n.path, rel: n.path.slice(SUB.length + 1), size: n.size || 0 }));
}

async function main() {
  console.log(`[live2d] 模型 ${MODEL} -> ${path.relative(ROOT, OUT_MODEL)}`);

  const files = await withRetry(listModelFiles, 'GitHub tree API');
  console.log(`[live2d] 文件清单 ${files.length} 个`);
  if (!files.length) throw new Error('未取到模型文件清单，请检查网络或仓库路径');

  let done = 0;
  let bytes = 0;
  for (const f of files) {
    const dest = path.join(OUT_MODEL, f.rel);
    // 已有且大小一致则跳过，便于断点续传
    try {
      const st = await fsp.stat(dest);
      if (f.size ? st.size === f.size : st.size > 0) {
        done++;
        bytes += st.size;
        continue;
      }
    } catch {
      /* 不存在，继续下载 */
    }
    const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${encodeURI(f.path)}`;
    const n = await withRetry(() => download(url, dest), f.rel);
    bytes += n;
    done++;
    if (done % 10 === 0 || done === files.length) {
      console.log(`[live2d] ${done}/${files.length}`);
    }
  }
  console.log(`[live2d] 模型就绪：${done} 个文件，${human(bytes)}`);

  // Cubism Core（Live2D 官方 Web 运行时，随应用分发的公共 CDN 版本）
  const coreDest = path.join(OUT_VENDOR, 'live2dcubismcore.min.js');
  if (fs.existsSync(coreDest) && fs.statSync(coreDest).size > 1000) {
    console.log('[live2d] Cubism Core 已存在，跳过');
  } else {
    const n = await withRetry(() => download(CUBISM_CORE_URL, coreDest), 'Cubism Core');
    console.log(`[live2d] Cubism Core 就绪：${human(n)}`);
  }

  // 许可声明
  const noticeDir = path.join(ROOT, 'docs');
  await fsp.mkdir(noticeDir, { recursive: true });
  try {
    await withRetry(
      () => download(`https://raw.githubusercontent.com/${REPO}/${REF}/LICENSE.md`, path.join(noticeDir, 'live2d-sample-models-LICENSE.md')),
      'LICENSE.md'
    );
    console.log('[live2d] 许可原文已保存到 docs/live2d-sample-models-LICENSE.md');
  } catch (e) {
    console.warn('[live2d] 许可原文下载失败（不影响运行）:', e.message);
  }

  console.log('[live2d] 完成');
}

main().catch((err) => {
  console.error('[live2d] 失败:', err.message);
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_/i.test(String(err.message))) {
    console.error(
      '[live2d] 看起来是证书链问题：这台机器上 Node 自带的根证书不认 GitHub。\n' +
        '         解决办法：用 `npm run fetch:live2d`（脚本里已经带了 --use-system-ca），\n' +
        '         或者手动执行 `node --use-system-ca scripts/fetch-live2d.mjs`。'
    );
  }
  process.exitCode = 1;
});
