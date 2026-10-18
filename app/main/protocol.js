'use strict';
/**
 * 自定义协议 app://local/<相对路径>
 *
 * 透明窗口里直接 file:// 加载页面时，Chromium 会拦掉对模型文件（.model3.json / .moc3 /
 * 纹理）的 fetch，所以这里注册一个标准安全协议，由主进程把请求映射到 app 资源目录。
 * 好处：不用关 webSecurity，也不用把整个宠物页面搬进 HTTP 服务。
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { protocol, net } = require('electron');
const { APP_DIR, modelDir } = require('../core/paths');
const { scoped } = require('../core/logger');

const log = scoped('protocol');

const SCHEME = 'app';
/** app://local/__runtime__/xxx → 用户数据目录下的运行时模型（不能放进只读的 app 目录） */
const RUNTIME_PREFIX = '__runtime__';

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        allowServiceWorkers: false,
      },
    },
  ]);
}

function install() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');

      let root = APP_DIR;
      let sub = rel;
      if (rel === RUNTIME_PREFIX || rel.startsWith(RUNTIME_PREFIX + '/')) {
        root = modelDir();
        sub = rel.slice(RUNTIME_PREFIX.length).replace(/^\/+/, '');
      }

      const target = path.resolve(root, sub);
      if (target !== root && !target.startsWith(root + path.sep)) {
        return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } });
      }

      let res;
      try {
        res = await net.fetch(pathToFileURL(target).toString(), { bypassCustomProtocolHandlers: true });
      } catch (err) {
        // 文件不存在时 net.fetch 会直接抛 ERR_FILE_NOT_FOUND，这里按 404 处理
        if (String(err && err.message).includes('ERR_FILE_NOT_FOUND')) {
          log.debug('资源不存在', sub);
          return new Response(`not found: ${sub}`, { status: 404, headers: { 'content-type': 'text/plain' } });
        }
        throw err;
      }
      if (!res.ok) {
        log.debug('资源不可用', sub, res.status);
        return new Response(`not found: ${sub}`, { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return res;
    } catch (err) {
      log.error('协议处理失败', err.message);
      return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
  });
  log.info(`已注册 ${SCHEME}:// 协议`);
}

const url = (rel) => `${SCHEME}://local/${String(rel).replace(/^\/+/, '')}`;

module.exports = { registerScheme, install, url, SCHEME };
