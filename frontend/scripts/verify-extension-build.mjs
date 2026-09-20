import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const outputFiles = ['content.js', 'background.js'];
const forbiddenPatterns = [
  {
    pattern: /process\.env\.NODE_ENV/,
    description: 'process.env.NODE_ENV',
  },
];

for (const outputFile of outputFiles) {
  const outputPath = resolve('dist', outputFile);
  const source = await readFile(outputPath, 'utf8');

  for (const { pattern, description } of forbiddenPatterns) {
    if (pattern.test(source)) {
      throw new Error(`${outputFile} 仍包含浏览器中不可用的 ${description}`);
    }
  }
}

const browserErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('error', (error) => browserErrors.push(String(error)));
virtualConsole.on('jsdomError', (error) => browserErrors.push(String(error)));
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://www.cc98.org/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});
dom.window.chrome = {
  runtime: {
    sendMessage(_message, callback) {
      callback({
        ok: true,
        settings: {
          llmBaseUrl: 'https://models.example.com/v1',
          llmApiKey: '',
          llmModel: 'test-model',
          searchRequestLimit: 30,
          feedbackEvidenceLimit: 30,
          finalRerankEnabled: true,
          finalRerankTopM: 30,
          searchBudgetSeconds: 60,
          hasApiKey: false,
        },
      });
    },
  },
};

// Production uses a closed root. The smoke test opens it only so it can assert
// that the bundled content script rendered and the interaction is wired.
const attachShadow = dom.window.Element.prototype.attachShadow;
dom.window.Element.prototype.attachShadow = function attachInspectableShadow(init) {
  return attachShadow.call(this, { ...init, mode: 'open' });
};

const contentSource = await readFile(resolve('dist', 'content.js'), 'utf8');
dom.window.eval(contentSource);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

const host = dom.window.document.getElementById('zju-forum-search-extension');
const orb = host?.shadowRoot?.querySelector('button.orb');
orb?.click();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
const drawer = host?.shadowRoot?.querySelector('aside.drawer');

if ('process' in dom.window) throw new Error('浏览器烟雾测试意外暴露了 Node process 全局');
if (!host || !orb) throw new Error('content.js 未能挂载 98 悬浮球');
if (!drawer?.classList.contains('open')) throw new Error('点击 98 悬浮球后侧栏没有展开');
if (browserErrors.length > 0) throw new Error(`content.js 运行时错误：${browserErrors.join('; ')}`);

dom.window.close();

let registeredMessageListener;
const workerDom = new JSDOM('', { runScripts: 'outside-only' });
workerDom.window.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        registeredMessageListener = listener;
      },
    },
  },
  storage: {
    local: {
      get(_key, callback) { callback({}); },
      set(_value, callback) { callback(); },
    },
  },
  permissions: {
    request(_value, callback) { callback(true); },
  },
};
workerDom.window.eval(await readFile(resolve('dist', 'background.js'), 'utf8'));
if (typeof registeredMessageListener !== 'function') {
  throw new Error('background.js 未能注册 runtime.onMessage 监听器');
}
workerDom.window.close();

console.log('扩展构建产物检查通过');
