import { createServer } from 'node:http';

const port = Number(process.env.MOCK_PORT ?? 18787);

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

const validPlan = {
  summary: '验收用首轮规划',
  searches: [{ query: '验收', purpose: '验证首轮规划链路' }],
  required_concepts: [],
  excluded_terms: [],
  time_constraint: { expression: '', start_date: null, end_date: null },
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

  // Deliberately log only method and path. Authorization and request body are
  // never read or written, so this test server cannot leak a key.
  process.stdout.write(`[mock] ${request.method} ${url.pathname}\n`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  if (url.pathname === '/valid/v1/chat/completions') {
    sendJson(response, 200, { choices: [{ message: { content: JSON.stringify(validPlan) } }] });
    return;
  }

  if (url.pathname === '/invalid/v1/chat/completions') {
    sendJson(response, 200, {
      choices: [{ message: { content: JSON.stringify({ summary: '故意不完整的验收响应', searches: [] }) } }],
    });
    return;
  }

  sendJson(response, 404, { error: 'unknown test route' });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[mock] listening on http://127.0.0.1:${port}\n`);
});

function close() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
