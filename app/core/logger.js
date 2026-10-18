'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { logDir } = require('./paths');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const LEVEL = LEVELS[(process.env.PET_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const MAX_FILE_BYTES = 2 * 1024 * 1024;
let stream = null;

function fileStream() {
  if (stream) return stream;
  try {
    const file = path.join(logDir(), 'pet.log');
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE_BYTES) {
      fs.renameSync(file, file + '.1');
    }
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch {
    stream = null;
  }
  return stream;
}

function write(level, scope, args) {
  if (LEVELS[level] < LEVEL) return;
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  const line = `${time} [${level.toUpperCase()}] [${scope}] ${text}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  const s = fileStream();
  if (s) s.write(line + '\n');
}

function scoped(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

module.exports = { scoped, log: scoped('app') };
