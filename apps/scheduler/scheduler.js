const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const amqp = require('amqplib');

const intervalMs = Number(process.env.INTERVAL_MS || 10000);
const port = Number(process.env.PORT || 5000);
const queueName = process.env.QUEUE_NAME || 'jobs.primary';
const dlxName = process.env.DLX_NAME || 'jobs.dlx';
const routingKey = process.env.ROUTING_KEY || 'jobs.run';
const runHistoryLimit = Number(process.env.RUN_HISTORY_LIMIT || 50);
const amqpUrl = process.env.AMQP_URL || 'amqp://localhost:5672';
const dataDir = process.env.SCHEDULER_DATA_DIR || path.resolve(__dirname, '../../data');
const schedulerRunsFile = path.join(dataDir, 'scheduler-runs.ndjson');

let connection = null;
let channel = null;
let intervalHandle = null;
let isStopping = false;
let queuedCount = 0;
let failedToQueueCount = 0;
let lastQueuedAt = null;

const queueHistory = [];

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rememberQueued(run) {
  queueHistory.unshift(run);
  if (queueHistory.length > runHistoryLimit) {
    queueHistory.length = runHistoryLimit;
  }
}

async function appendQueued(run) {
  await fs.appendFile(schedulerRunsFile, `${JSON.stringify(run)}\n`, 'utf8');
}

async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function connectBroker() {
  connection = await amqp.connect(amqpUrl);
  channel = await connection.createChannel();
  await channel.assertExchange(dlxName, 'direct', { durable: true });
  await channel.assertQueue(queueName, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': dlxName,
      'x-dead-letter-routing-key': `${routingKey}.dead`,
    },
  });
  await channel.bindQueue(queueName, 'amq.direct', routingKey);
}

async function queueRun(trigger) {
  if (isStopping || !channel) {
    return;
  }
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const queuedAt = new Date().toISOString();
  const payload = {
    runId,
    jobName: 'write-heartbeat',
    trigger,
    queuedAt,
    attempts: 0,
  };

  const enqueued = channel.publish(
    'amq.direct',
    routingKey,
    Buffer.from(JSON.stringify(payload)),
    {
      persistent: true,
      contentType: 'application/json',
      messageId: runId,
      type: payload.jobName,
      timestamp: Date.now(),
    }
  );

  if (!enqueued) {
    failedToQueueCount += 1;
    return;
  }

  queuedCount += 1;
  lastQueuedAt = queuedAt;
  rememberQueued({ ...payload, status: 'queued' });
  await appendQueued({ ...payload, status: 'queued' });
  console.log(`[${queuedAt}] queued ${payload.jobName} run=${runId} trigger=${trigger}`);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      intervalMs,
      queueName,
      routingKey,
      amqpUrl,
      isStopping,
      queuedCount,
      failedToQueueCount,
      lastQueuedAt,
    });
    return;
  }

  if (req.url === '/runs') {
    sendJson(res, 200, { count: queueHistory.length, runs: queueHistory });
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    queueRun('manual')
      .then(() => sendJson(res, 202, { ok: true, queued: true }))
      .catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

async function shutdown(signal) {
  if (isStopping) {
    return;
  }
  isStopping = true;
  console.log(`received ${signal}, stopping scheduler`);
  if (intervalHandle) {
    clearInterval(intervalHandle);
  }
  await Promise.allSettled([
    channel ? channel.close() : Promise.resolve(),
    connection ? connection.close() : Promise.resolve(),
  ]);
  server.close(() => {
    process.exit(0);
  });
}

async function start() {
  await ensureStorage();
  await connectBroker();
  await queueRun('startup');
  intervalHandle = setInterval(() => {
    queueRun('interval').catch((error) => {
      failedToQueueCount += 1;
      console.error(`interval queue error: ${error.message}`);
    });
  }, intervalMs);
  server.listen(port, () => {
    console.log(`scheduler listening on ${port}`);
  });
}

start().catch((error) => {
  console.error(`scheduler failed to start: ${error.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error(`shutdown error: ${error.message}`);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error(`shutdown error: ${error.message}`);
    process.exit(1);
  });
});
