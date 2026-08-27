const http = require('http');

const port = process.env.PORT || 3000;
const instanceName = process.env.INSTANCE_NAME || 'web';

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    sendJson(res, 200, { ok: true, instanceName });
    return;
  }

  if (req.url === '/time') {
    sendJson(res, 200, { now: new Date().toISOString(), instanceName });
    return;
  }

  if (req.url === '/proxy') {
    sendJson(res, 200, {
      instanceName,
      proxy: {
        forwardedFor: req.headers['x-forwarded-for'] || null,
        forwardedProto: req.headers['x-forwarded-proto'] || null,
        requestId: req.headers['x-request-id'] || null,
        target: req.headers['x-proxy-target'] || null,
      },
    });
    return;
  }

  sendJson(res, 200, {
    message: 'scheduler-nginx web app',
    instanceName,
  });
});

server.listen(port, () => {
  console.log(`web listening on ${port}`);
});
