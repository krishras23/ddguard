# Primer: scheduler + Nginx

## 1. Conceptual foundation

This project is a tiny lab for two very different systems ideas: **doing work on a timer** and **forwarding web traffic**. A scheduler is a process that wakes up periodically and runs background work. Nginx is a front door that receives HTTP requests and sends them to the right backend. They solve different problems, but together they model a common real-world shape: one component handles background work, another handles user traffic, and a proxy sits in front.

> Think of the scheduler as the alarm clock and Nginx as the receptionist.

The scheduler exists because not all work starts with a request. Many systems must do things on a cadence: cleanup, sync, refresh, report, ping, retry. The proxy exists because you often want a stable public entrypoint in front of your app, even if the app itself runs on a private port. Learning both in one repo is useful because you can see how background work and request routing are separated.

## 2. Architecture and design patterns

Your current repo has three moving parts:

- `apps/scheduler/scheduler.js` runs a timer loop and logs a tick
- `apps/web/server.js` serves HTTP endpoints like `/health` and `/time`
- `infra/nginx/nginx.conf` proxies all inbound requests to the web app

> The main design pattern is **separation of concerns**.

The scheduler owns time. It decides when to run. The web app owns responses. It decides what to return for each URL. Nginx owns routing. It decides where the request goes and which headers are preserved. `docker-compose.yml` glues them together so they can run as a small system instead of three unrelated processes.

The key thing to understand is that these are separate failure domains. If the scheduler crashes, the web app can still answer health checks. If the web app crashes, Nginx may return upstream errors. If Nginx is misconfigured, the backend can still be healthy but unreachable through the proxy.

## 3. Ecosystem and integrations

There are many ways to build a scheduler:

- `cron`
- `systemd` timers
- Kubernetes CronJobs
- background workers like Sidekiq/Celery
- a custom loop like this one

For learning, a custom loop is best because it exposes the mechanics. You can see timing, execution, shutdown, and error handling directly. Nginx fits into the broader reverse-proxy ecosystem: it often sits in front of Node, Python, Go, Ruby, or Java apps to handle routing, TLS termination, buffering, and load balancing.

> Nginx is not the app. It is the traffic layer in front of the app.

In a bigger system, the scheduler could write state somewhere persistent and the web app could expose that state. Nginx would still only care about HTTP routing. That makes the architecture clean: worker, app, and edge are all distinct.

## 4. Data models and concepts

On the scheduler side, the main concepts are:

- **tick**: one wake-up event
- **job**: a unit of background work
- **run**: one execution attempt of a job
- **interval**: how often the scheduler wakes up
- **state**: pending, running, success, failed, skipped

Right now your scheduler only has a tick. That is enough to learn the rhythm of a timer loop. The next step would be to separate the scheduler heartbeat from actual job execution. That distinction matters because a tick is just a signal; a run is real work.

On the Nginx side, the main concepts are:

- **upstream**: the backend service
- **server block**: the listener and virtual host
- **location**: the routing rule
- **proxy headers**: request metadata passed downstream
- **timeouts/buffering**: edge behavior controls

> Scheduler answers **when**. Nginx answers **where**.

## 5. Common use cases and patterns

Schedulers are used when work must happen even if nobody is clicking anything:

- refresh data on a cadence
- clean stale records
- poll external systems
- emit heartbeats
- retry failed work later

Nginx is used when one stable public address should hide one or more backends:

- route all requests to one app
- split traffic by path, like `/api` vs `/`
- preserve client IP and scheme
- add TLS at the edge

> This repo models a very common production pattern: **background worker + HTTP service + reverse proxy**.

## 6. Real-world deployment and operational concerns

Schedulers get tricky when work overlaps, retries happen, or the process is restarted. If one run takes longer than the interval, should the next run wait? If the process dies mid-job, should the job be retried? If multiple copies run, how do you avoid duplicate work? Those are the real scheduler questions.

Nginx gets tricky when headers, ports, or timeouts are wrong. A lot of “Nginx bugs” are really upstream issues: the app isn’t reachable, the timeout is too short, or the proxy headers are incomplete. The proxy is only as good as the backend and the config.

## 7. Integration with this repository

This repo is already set up as a tiny lab:

- the web app proves HTTP works
- the scheduler proves timing works
- Nginx proves request forwarding works
- Compose proves the services can be wired together

That means the next learning step is not to add lots of features. It is to add one concept at a time:

1. make the scheduler run a named job
2. make the web app show that job state
3. route through Nginx
4. add one production concern, like shutdown or retry

## 8. Getting started / best practices

Start simple:

1. run the web app directly and hit `/health`
2. run the scheduler and watch ticks appear
3. run Nginx in front and verify proxying through `localhost:8080`
4. add one feature at a time

> If you cannot explain the failure mode of a change, the change is too big.

## 9. Common pitfalls and anti-patterns

The biggest mistake is treating the scheduler like a fancy `setInterval`. In real systems, scheduling is about overlap, retries, persistence, and idempotency. Another mistake is pushing too much business logic into Nginx. Nginx should route and enforce edge behavior, not become an application framework.

Also avoid coupling the scheduler and proxy too tightly. They should stay independent so you can understand failures clearly: timer bugs belong to the scheduler, routing bugs belong to Nginx, response bugs belong to the web app.

## 10. Advanced topics and deep dives

Once the basics are clear, the deeper scheduler topics are:

- drift and timer accuracy
- distributed locking
- idempotent job design
- at-least-once vs exactly-once execution
- graceful shutdown

The deeper Nginx topics are:

- upstream selection
- buffering vs streaming
- timeout tuning
- TLS termination
- trusted proxy headers

> The big lesson: scheduler is a **state machine with time**, and Nginx is a **policy layer for HTTP traffic**.
