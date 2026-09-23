import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const outputFiles = ['content.js', 'background.js', 'cc98-webvpn-bridge.js'];
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
const contentSource = await readFile(resolve('dist', 'content.js'), 'utf8');
for (const url of ['https://www.cc98.org/', 'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421e7e056d22433310830079bab/', 'https://www.duoduo.link/']) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  let contentListener;
  dom.window.chrome = {
    runtime: {
      onMessage: {
        addListener(listener) { contentListener = listener; },
        removeListener(listener) { if (contentListener === listener) contentListener = undefined; },
      },
      sendMessage(_message, callback) {
        callback({ ok: true, settings: {
          llmBaseUrl: 'https://models.example.com/v1', llmApiKey: '', llmModel: 'test-model',
          searchRequestLimit: 30, feedbackEvidenceLimit: 30, finalRerankEnabled: true,
          finalRerankTopM: 30, searchBudgetSeconds: 60, hasApiKey: false,
        } });
      },
    },
  };

  // Production uses a closed root. Inspect the bundled UI in the smoke test.
  const attachShadow = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function attachInspectableShadow(init) {
    return attachShadow.call(this, { ...init, mode: 'open' });
  };

  dom.window.eval(contentSource);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  const host = dom.window.document.getElementById('zju-forum-search-extension');
  const orb = host?.shadowRoot?.querySelector('button.orb');
  if (!host || !orb || typeof contentListener !== 'function') throw new Error(`${url} 内容脚本未能挂载`);
  contentListener({ type: 'ui:open' });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  const drawer = host.shadowRoot.querySelector('aside.drawer');
  if (!drawer?.classList.contains('open')) throw new Error(`${url} 扩展图标消息未能打开侧栏`);
  host.shadowRoot.querySelector('button.close')?.click();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  orb.click();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  if (!drawer.classList.contains('open')) throw new Error(`${url} 悬浮球未能打开侧栏`);
  if ('process' in dom.window) throw new Error('浏览器烟雾测试意外暴露了 Node process 全局');
  dom.window.close();
}
if (browserErrors.length > 0) throw new Error(`content.js 运行时错误：${browserErrors.join('; ')}`);

let registeredMessageListener;
let registeredActionClick;
let actionMessage;
const workerDom = new JSDOM('', { runScripts: 'outside-only' });
workerDom.window.chrome = {
  action: { onClicked: { addListener(listener) { registeredActionClick = listener; } } },
  tabs: { sendMessage(tabId, message, callback) { actionMessage = { tabId, message }; callback(); } },
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
if (typeof registeredActionClick !== 'function') throw new Error('background.js 未能注册扩展图标点击事件');
registeredActionClick({ id: 7 });
if (actionMessage?.tabId !== 7 || actionMessage.message?.type !== 'ui:open') {
  throw new Error('点击扩展图标未能向当前标签页发送打开消息');
}
workerDom.window.close();

const bridgeDom = new JSDOM('', {
  url: 'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421e7e056d22433310830079bab/',
  runScripts: 'outside-only',
});
const bridgeCalls = [];
Object.assign(bridgeDom.window, {
  Headers, Request,
  fetch: async (url, init) => {
    bridgeCalls.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  },
});
bridgeDom.window.eval(await readFile(resolve('dist', 'cc98-webvpn-bridge.js'), 'utf8'));
await bridgeDom.window.fetch('https://api.cc98.org/me', { headers: { Authorization: 'Bearer synthetic-only' } });
const bridgeResponse = new Promise((resolvePromise, rejectPromise) => {
  const timeout = setTimeout(() => rejectPromise(new Error('WebVPN 构建产物未响应搜索请求')), 1000);
  bridgeDom.window.document.addEventListener('zju-forum-search:webvpn-response', (event) => {
    clearTimeout(timeout);
    resolvePromise(JSON.parse(event.detail));
  }, { once: true });
});
bridgeDom.window.document.dispatchEvent(new bridgeDom.window.CustomEvent('zju-forum-search:webvpn-request', {
  detail: JSON.stringify({
    id: 'build-smoke',
    url: 'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421f1e748d22433310830079bab/topic/search?keyword=test&from=0&size=20',
  }),
}));
if ((await bridgeResponse).status !== 200 || bridgeCalls[1]?.authorization !== 'Bearer synthetic-only') {
  throw new Error('WebVPN 构建产物未能复用合成授权执行搜索');
}
bridgeDom.window.close();

console.log('扩展构建产物检查通过');
