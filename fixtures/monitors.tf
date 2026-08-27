terraform {
  required_providers {
    datadog = {
      source  = "DataDog/datadog"
      version = "~> 3.39"
    }
  }
}

resource "datadog_monitor" "worker_dead_letters" {
  name    = "[P1][worker] Dead-lettered jobs (demo)"
  type    = "query alert"
  query   = "sum(last_10m):sum:worker.runs.processed{env:demo,service:worker,status:dead-lettered}.as_count() >= 1"
  message = <<-EOT
    A job exhausted MAX_ATTEMPTS and landed on jobs.dead.

    Runbook: https://runbooks.example.internal/worker/dead-letters
    @pagerduty-worker-oncall @slack-worker-alerts
  EOT

  monitor_thresholds {
    critical          = 1
    critical_recovery = 0
  }

  priority            = 1
  notify_no_data      = true
  no_data_timeframe   = 30
  require_full_window = false
  renotify_interval   = 60

  tags = ["team:platform", "service:worker", "env:demo"]
}

resource "datadog_monitor" "worker_processed_drop" {
  name    = "[P1][worker] Jobs processed drop"
  type    = "query alert"
  query   = "sum(last_15m):sum:worker.runs.procesed{env:demo,service:worker,status:success}.as_count() < 20"
  message = <<-EOT
    Successful job throughput fell below the floor for 15m.

    Runbook: https://runbooks.example.internal/worker/throughput
    @slack-worker-alerts
  EOT

  monitor_thresholds {
    critical          = 20
    critical_recovery = 30
  }

  priority            = 1
  notify_no_data      = true
  no_data_timeframe   = 30
  require_full_window = false

  tags = ["team:platform", "service:worker", "env:demo"]
}

resource "datadog_monitor" "scheduler_queue_rate" {
  name    = "[P2][scheduler] Queue rate below floor"
  type    = "query alert"
  query   = "sum(last_15m):sum:scheduler.runs.queued{env:prod,service:scheduler}.as_count() < 5"
  message = <<-EOT
    The scheduler loop is publishing fewer runs than the interval schedule implies.

    Runbook: https://runbooks.example.internal/scheduler/queue-rate
    @slack-scheduler-alerts
  EOT

  monitor_thresholds {
    critical          = 5
    critical_recovery = 10
  }

  priority            = 2
  notify_no_data      = true
  no_data_timeframe   = 30
  require_full_window = false

  tags = ["team:platform", "service:scheduler", "env:demo"]
}

resource "datadog_monitor" "nginx_5xx_rate" {
  name    = "[P1][nginx] 5xx rate high"
  type    = "query alert"
  query   = "sum(last_5m):sum:nginx.requests{env:demo,service:nginx,status_class:5xx}.as_count() > 30"
  message = <<-EOT
    The edge proxy is returning 5xx above the error budget burn rate.

    Runbook: https://runbooks.example.internal/nginx/5xx
    @pagerduty-nginx-onclal @slack-nginx-alerts
  EOT

  monitor_thresholds {
    critical          = 30
    critical_recovery = 15
  }

  priority        = 1
  on_missing_data = "resolve"

  tags = ["team:platform", "service:nginx", "env:demo"]
}

resource "datadog_monitor" "worker_queue_latency" {
  name    = "[P2][worker] Queue latency high"
  type    = "query alert"
  query   = "avg(last_5m):avg:worker.queue.latency{env:demo,service:worker} > 100"
  message = <<-EOT
    Time between publish and ack is above target.

    Runbook: https://runbooks.example.internal/worker/queue-latency
    @slack-worker-alerts
  EOT

  monitor_thresholds {
    critical          = 100
    critical_recovery = 50
  }

  priority          = 2
  notify_no_data    = false
  no_data_timeframe = 10
  evaluation_delay  = 60

  tags = ["team:platform", "service:worker", "env:demo"]
}

resource "datadog_monitor" "nginx_canary_errors" {
  name    = "[P2][nginx] Canary 5xx elevated"
  type    = "query alert"
  query   = "sum(last_5m):sum:nginx.requests{env:demo,service:nginx,status_class:5xx,target:web_canary}.as_count() > 20"
  message = <<-EOT
    The canary target is erroring more than the primary. Consider shifting weight back.

    Runbook: https://runbooks.example.internal/nginx/canary
    @slack-nginx-alerts
  EOT

  monitor_thresholds {
    critical = 20
  }

  priority            = 2
  notify_no_data      = false
  no_data_timeframe   = 10
  require_full_window = false

  tags = ["team:platform", "service:nginx", "env:demo"]
}

resource "datadog_monitor" "worker_queue_depth" {
  name    = "[P3][worker] Queue backlog"
  type    = "query alert"
  query   = "avg(last_10m):avg:worker.queue.depth{env:demo,service:worker} > 999999"
  message = <<-EOT
    jobs.primary is accumulating faster than the worker drains it.

    Runbook: https://runbooks.example.internal/worker/backlog
    @slack-worker-alerts
  EOT

  monitor_thresholds {
    critical          = 999999
    critical_recovery = 500000
  }

  priority          = 3
  notify_no_data    = true
  no_data_timeframe = 20

  tags = ["team:platform", "service:worker", "env:demo"]
}

resource "datadog_monitor" "scheduler_runs_by_trigger" {
  name    = "[P2][scheduler] Trigger stopped queueing"
  type    = "query alert"
  query   = "sum(last_30m):sum:scheduler.runs.queued{env:demo,service:scheduler} by {trigger}.as_count() < 1"
  message = <<-EOT
    A trigger has published nothing for 30m.

    Runbook: https://runbooks.example.internal/scheduler/triggers
    @slack-scheduler-alerts
  EOT

  monitor_thresholds {
    critical          = 1
    critical_recovery = 2
  }

  priority            = 2
  notify_no_data      = true
  no_data_timeframe   = 10
  require_full_window = false

  tags = ["team:platform", "service:scheduler", "env:demo"]
}
