// 生成应用图标：纯 Node 实现，不引入图像库。
// 产出 build/icon.ico（256，PNG 内嵌式 ICO）与 app/assets/icons/*.png。
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * 在 [0,1] 归一化坐标里绘制角色头像。
 * 返回 {r,g,b,a}（0~255 / 0~1）
 */
function shade(x, y) {
  const cx = 0.5;
  const cy = 0.53;
  // 圆润的身体（略扁，像一只小团子）
  const dx = (x - cx) / 0.44;
  const dy = (y - cy) / 0.42;
  const d = Math.sqrt(dx * dx + dy * dy);
  const bodyA = 1 - smoothstep(0.985, 1.02, d);
  if (bodyA <= 0.002) return [0, 0, 0, 0];

  // 渐变主体：上浅蓝 -> 下淡紫
  const t = clamp((y - (cy - 0.42)) / 0.84, 0, 1);
  let r = mix(0x9f, 0xc9, t);
  let g = mix(0xd6, 0xb6, t);
  let b = mix(0xf2, 0xf7, t);

  // 左上高光
  const hl = Math.exp(-(((x - 0.36) ** 2 + (y - 0.36) ** 2) / 0.035));
  r = mix(r, 255, hl * 0.5);
  g = mix(g, 255, hl * 0.5);
  b = mix(b, 255, hl * 0.5);

  // 底部轻微暗边，增加体积感
  const shadeF = smoothstep(0.55, 1.0, y);
  r *= 1 - shadeF * 0.13;
  g *= 1 - shadeF * 0.13;
  b *= 1 - shadeF * 0.1;

  const ink = (px, py, rx, ry) => {
    const ex = (x - px) / rx;
    const ey = (y - py) / ry;
    return 1 - smoothstep(0.92, 1.06, Math.sqrt(ex * ex + ey * ey));
  };

  // 腮红
  const blush = Math.max(ink(0.3, 0.63, 0.085, 0.055), ink(0.7, 0.63, 0.085, 0.055));
  if (blush > 0) {
    r = mix(r, 0xf7, blush * 0.55);
    g = mix(g, 0x92, blush * 0.55);
    b = mix(b, 0xa8, blush * 0.55);
  }

  // 眼睛
  const eyeL = ink(0.365, 0.5, 0.062, 0.082);
  const eyeR = ink(0.635, 0.5, 0.062, 0.082);
  const eye = Math.max(eyeL, eyeR);
  // 高光点
  const glint = Math.max(ink(0.345, 0.47, 0.02, 0.024), ink(0.615, 0.47, 0.02, 0.024));

  // 嘴（小弧线：用环形减去下半部分）
  const mdx = (x - 0.5) / 0.075;
  const mdy = (y - 0.63) / 0.055;
  const ring = Math.sqrt(mdx * mdx + mdy * mdy);
  const mouth = (1 - smoothstep(1.02, 1.12, ring)) * smoothstep(0.83, 0.9, ring) * smoothstep(0.6, 0.72, y);

  if (eye > 0) {
    r = mix(r, 0x33, eye);
    g = mix(g, 0x36, eye);
    b = mix(b, 0x4d, eye);
    if (glint > 0) {
      r = mix(r, 0xff, glint * 0.95);
      g = mix(g, 0xff, glint * 0.95);
      b = mix(b, 0xff, glint * 0.95);
    }
  }
  if (mouth > 0.02) {
    r = mix(r, 0x4a, mouth * 0.85);
    g = mix(g, 0x4a, mouth * 0.85);
    b = mix(b, 0x62, mouth * 0.85);
  }

  // 描边
  const edge = smoothstep(0.93, 0.995, d) * (1 - smoothstep(1.0, 1.05, d));
  r = mix(r, 0x46, edge * 0.55);
  g = mix(g, 0x4a, edge * 0.55);
  b = mix(b, 0x74, edge * 0.55);

  return [r, g, b, bodyA];
}

function render(size, ss = 4) {
  const buf = Buffer.alloc(size * size * 4);
  const inv = 1 / (size * ss);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px * ss + sx + 0.5) * inv;
          const y = (py * ss + sy + 0.5) * inv;
          const c = shade(x, y);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      if (a > 0.0001) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
        buf[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return encodePng(size, size, buf);
}

// ---------- ICO 封装 ----------
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

// ---------- 主流程 ----------
const iconDir = path.join(ROOT, 'app', 'assets', 'icons');
const buildDir = path.join(ROOT, 'build');
fs.mkdirSync(iconDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });

const targets = [
  { size: 256, file: path.join(iconDir, 'icon.png') },
  { size: 128, file: path.join(iconDir, 'icon-128.png') },
  { size: 64, file: path.join(iconDir, 'icon-64.png') },
  { size: 32, file: path.join(iconDir, 'tray.png') },
  { size: 16, file: path.join(iconDir, 'tray-16.png') },
];

const made = {};
for (const t of targets) {
  const png = render(t.size);
  fs.writeFileSync(t.file, png);
  made[t.size] = png;
  console.log(`[icons] ${path.relative(ROOT, t.file)}  ${png.length} B`);
}

const ico = encodeIco([256, 64, 32, 16].map((s) => ({ size: s, data: made[s] })));
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
console.log(`[icons] build/icon.ico  ${ico.length} B`);
