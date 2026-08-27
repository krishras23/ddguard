# scheduler-nginx

Minimal learning project for:

- a tiny scheduler loop
- RabbitMQ queue + worker + DLQ flow
- an Nginx reverse proxy

## What this repo teaches

- how a **scheduler** runs work on a timer
- how a scheduler **publishes jobs to a queue**
- how a worker **consumes jobs with retry + dead-letter handling**
- how **Nginx** forwards requests to a backend
- how a small system is split into **app**, **worker**, and **edge proxy**
- how a reverse proxy can do **load balancing, rate limiting, WAF filtering, canary routing, observability, and TLS termination**

## Files

```bash
apps/web/server.js
apps/scheduler/scheduler.js
apps/worker/worker.js
infra/nginx/nginx.conf
docker-compose.yml
```

## Run

```bash
npm run start:web
npm run start:scheduler
npm run start:worker
```

## Scheduler endpoints

- `GET http://localhost:5000/health` - scheduler status and counters
- `GET http://localhost:5000/runs` - recent queued run history (in-memory view)
- `POST http://localhost:5000/run` - enqueue one manual run

The scheduler also writes artifacts under `data/`:

- `data/scheduler-runs.ndjson` - append-only queued run history
- `data/worker-runs.ndjson` - worker processing history (success/retry/dead-letter)

## Queue architecture

- `scheduler` publishes to RabbitMQ queue `jobs.primary` with routing key `jobs.run`
- `worker` consumes `jobs.primary`
- failed messages retry until `MAX_ATTEMPTS`
- once max attempts is reached, message is published to DLQ `jobs.dead` via exchange `jobs.dlx`

TLS certs are generated locally and not committed - run `make certs` once before `docker compose up`.

For the proxy demo, run the compose stack and hit:

- `http://localhost:8080` for the HTTP redirect
- `https://localhost:8443` for the reverse proxy
- `https://localhost:8443/proxy` to see proxy headers and instance routing

RabbitMQ management UI (when compose stack is running):

- `http://localhost:15672` (`guest` / `guest`)

## Primer

See [`primer.md`](./primer.md) for the full explanation of how to think about the scheduler, Nginx, and the system as a whole.
