(() => {
  const apiBase = 'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421f1e748d22433310830079bab';
  const requestEvent = 'zju-forum-search:webvpn-request';
  const responseEvent = 'zju-forum-search:webvpn-response';
  const cancelEvent = 'zju-forum-search:webvpn-cancel';
  const refillIntervalMs = 2000;
  const burstCapacity = 2;
  const pending = new Map();
  let availableRequests = burstCapacity;
  let lastRefillAt = Date.now();
  let authorization = null;
  const originalFetch = window.fetch;

  window.fetch = function captureCc98Authorization(input, init) {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin === 'https://api.cc98.org' || url.href.startsWith(`${apiBase}/`)) {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        const candidate = headers.get('Authorization');
        if (candidate && /^Bearer\s+\S+$/i.test(candidate)) authorization = candidate;
      }
    } catch { /* Leave the site's request untouched. */ }
    return originalFetch.apply(this, arguments);
  };

  document.addEventListener(requestEvent, async (event) => {
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (!request || typeof request.id !== 'string' || !request.id || request.id.length > 128 || typeof request.url !== 'string') return;
    let url;
    try { url = new URL(request.url); } catch { return; }
    if (url.origin !== 'https://webvpn.zju.edu.cn' || url.pathname !== new URL(`${apiBase}/topic/search`).pathname) return;
    const keyword = url.searchParams.get('keyword');
    const from = url.searchParams.get('from');
    if ([...url.searchParams.keys()].sort().join(',') !== 'from,keyword,size'
      || !keyword?.trim() || keyword.length > 512
      || !/^\d+$/.test(from ?? '') || !Number.isSafeInteger(Number(from)) || Number(from) > 5000
      || url.searchParams.get('size') !== '20') return;

    const reply = (data) => document.dispatchEvent(new CustomEvent(responseEvent, {
      detail: JSON.stringify({ id: request.id, ...data }),
    }));
    if (!authorization) {
      reply({ status: 401, contentType: 'application/json', body: '' });
      return;
    }
    if (pending.has(request.id)) return;
    const now = Date.now();
    availableRequests = Math.min(burstCapacity, availableRequests + Math.max(0, now - lastRefillAt) / refillIntervalMs);
    lastRefillAt = now;
    if (pending.size > 0 || availableRequests < 1) {
      reply({ status: 429, contentType: 'application/json', body: '' });
      return;
    }
    availableRequests -= 1;

    const controller = new AbortController();
    pending.set(request.id, controller);
    try {
      const response = await window.fetch(url.toString(), {
        method: 'GET', credentials: 'include', signal: controller.signal,
        headers: { Authorization: authorization, Accept: 'application/json' },
      });
      const body = await response.text();
      reply({ status: response.status, contentType: response.headers.get('content-type') ?? '', body });
    } catch {
      reply({ status: 503, contentType: 'application/json', body: '' });
    } finally {
      pending.delete(request.id);
    }
  });

  document.addEventListener(cancelEvent, (event) => {
    if (typeof event.detail === 'string') pending.get(event.detail)?.abort();
  });
})();
