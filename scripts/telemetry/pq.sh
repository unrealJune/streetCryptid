#!/bin/sh
# pq.sh "<PromQL>" [hours_back] [step_seconds]  -> Prometheus query_range JSON (span metrics)
# The span-metrics series (`traces_span_metrics_calls_total`, by `service_instance_id`, `span_name`,
# `service_version`, `sc_peer`, …) are the reliable "when did this phone last say anything" source:
# Tempo search with a limit does NOT reliably return the newest spans. See infra/otel/README.md.
. "$(dirname "$0")/lib.sh"
Q="$1"; H="${2:-24}"; STEP="${3:-900}"
NOW=$(date +%s); START=$((NOW - H*3600))
grafana_curl /api/datasources/proxy/uid/mimir-streetcryptid/api/v1/query_range -G \
  --data-urlencode "query=$Q" \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$NOW" \
  --data-urlencode "step=$STEP"
