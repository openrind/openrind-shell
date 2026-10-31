import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const child = spawn('/usr/lib/chromium/chromium', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--remote-debugging-port=9221',
  '--remote-allow-origins=*',
  'about:blank'
], { stdio: 'inherit' });

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, 'http://127.0.0.1:9221');
  const path = urlObj.pathname + urlObj.search;
  const proxyReq = http.request({
    host: '127.0.0.1',
    port: 9221,
    path,
    method: req.method,
    headers: {
      ...req.headers,
      host: '127.0.0.1:9221',
    },
  }, (proxyRes) => {
    const isJson = (proxyRes.headers['content-type'] || '').includes('json');
    if (isJson && (urlObj.pathname === '/json/version' || urlObj.pathname === '/json' || urlObj.pathname === '/json/list')) {
      let chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const hostHeader = req.headers.host || 'openrind-browser-pod:9222';
        const bodyStr = Buffer.concat(chunks).toString('utf8').replaceAll('127.0.0.1:9221', hostHeader);
        const headers = { ...proxyRes.headers, 'content-length': Buffer.byteLength(bodyStr) };
        res.writeHead(proxyRes.statusCode, headers);
        res.end(bodyStr);
      });
      return;
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });

  req.pipe(proxyReq);
});

server.on('upgrade', (req, socket, head) => {
  const urlObj = new URL(req.url, 'http://127.0.0.1:9221');
  const path = urlObj.pathname + urlObj.search;
  const targetSocket = net.connect(9221, '127.0.0.1', () => {
    const rawReq = [
      `${req.method} ${path} HTTP/1.1`,
      'Host: 127.0.0.1:9221',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
      'Sec-WebSocket-Version: 13',
    ];
    if (req.headers['sec-websocket-protocol']) {
      rawReq.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
    }
    rawReq.push('', '');
    targetSocket.write(rawReq.join('\r\n'));
    if (head && head.length) targetSocket.write(head);
    targetSocket.pipe(socket);
    socket.pipe(targetSocket);
  });
  targetSocket.on('error', () => socket.destroy());
  socket.on('error', () => targetSocket.destroy());
});

server.listen(9222, '0.0.0.0', () => {
  console.log('Browser pod ready on 0.0.0.0:9222');
});

const shutdown = () => {
  child.kill('SIGTERM');
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
