const fs = require('fs/promises');
const path = require('path');
const amqp = require('amqplib');

const amqpUrl = process.env.AMQP_URL || 'amqp://localhost:5672';
const queueName = process.env.QUEUE_NAME || 'jobs.primary';
const dlqName = process.env.DLQ_NAME || 'jobs.dead';
const dlxName = process.env.DLX_NAME || 'jobs.dlx';
const routingKey = process.env.ROUTING_KEY || 'jobs.run';
const maxAttempts = Number(process.env.MAX_ATTEMPTS || 3);
const dataDir = process.env.WORKER_DATA_DIR || path.resolve(__dirname, '../../data');
const workerRunsFile = path.join(dataDir, 'worker-runs.ndjson');
const failEvery = Number(process.env.FAIL_EVERY || 0);

let runCount = 0;

async function appendRun(run) {
  await fs.appendFile(workerRunsFile, `${JSON.stringify(run)}\n`, 'utf8');
}

async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });
}

function shouldFailThisRun() {
  if (!failEvery || failEvery <= 0) {
    return false;
  }
  return runCount % failEvery === 0;
}

async function processMessage(channel, message) {
  if (!message) {
    return;
  }

  runCount += 1;
  const startedAt = new Date().toISOString();
  const payload = JSON.parse(message.content.toString());
  const attempts = Number(payload.attempts || 0);

  try {
    if (shouldFailThisRun()) {
      throw new Error(`simulated failure on run ${runCount}`);
    }

    const result = {
      ...payload,
      processedAt: new Date().toISOString(),
      status: 'success',
      attempts,
    };
    await appendRun(result);
    channel.ack(message);
    console.log(`[${startedAt}] processed run=${payload.runId} attempts=${attempts}`);
  } catch (error) {
    const nextAttempts = attempts + 1;
    if (nextAttempts >= maxAttempts) {
      const deadLetter = {
        ...payload,
        failedAt: new Date().toISOString(),
        status: 'dead-lettered',
        attempts: nextAttempts,
        error: error.message,
      };
      await appendRun(deadLetter);
      channel.publish(dlxName, `${routingKey}.dead`, Buffer.from(JSON.stringify(deadLetter)), {
        persistent: true,
        contentType: 'application/json',
        messageId: payload.runId,
      });
      channel.ack(message);
      console.error(
        `[${startedAt}] dead-lettered run=${payload.runId} attempts=${nextAttempts} error=${error.message}`
      );
      return;
    }

    const retryPayload = { ...payload, attempts: nextAttempts, lastError: error.message };
    channel.publish('amq.direct', routingKey, Buffer.from(JSON.stringify(retryPayload)), {
      persistent: true,
      contentType: 'application/json',
      messageId: payload.runId,
    });
    await appendRun({
      ...retryPayload,
      status: 'retry-queued',
      retriedAt: new Date().toISOString(),
    });
    channel.ack(message);
    console.warn(`[${startedAt}] retry queued run=${payload.runId} attempts=${nextAttempts}`);
  }
}

async function start() {
  await ensureStorage();
  const connection = await amqp.connect(amqpUrl);
  const channel = await connection.createChannel();

  await channel.assertExchange(dlxName, 'direct', { durable: true });
  await channel.assertQueue(queueName, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': dlxName,
      'x-dead-letter-routing-key': `${routingKey}.dead`,
    },
  });
  await channel.bindQueue(queueName, 'amq.direct', routingKey);
  await channel.assertQueue(dlqName, { durable: true });
  await channel.bindQueue(dlqName, dlxName, `${routingKey}.dead`);
  await channel.prefetch(1);

  console.log(`worker consuming queue=${queueName} dlq=${dlqName}`);

  await channel.consume(
    queueName,
    (message) => {
      processMessage(channel, message).catch((error) => {
        console.error(`worker process error: ${error.message}`);
        if (message) {
          channel.nack(message, false, true);
        }
      });
    },
    { noAck: false }
  );

  async function shutdown(signal) {
    console.log(`received ${signal}, stopping worker`);
    await Promise.allSettled([channel.close(), connection.close()]);
    process.exit(0);
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(() => process.exit(1));
  });
}

start().catch((error) => {
  console.error(`worker failed to start: ${error.message}`);
  process.exit(1);
});
