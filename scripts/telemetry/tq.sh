#!/bin/sh
# tq.sh "<TraceQL>" [hours_back] [limit]  -> Tempo search JSON
# start/end must be integer epoch seconds (a float is a bare 400). See infra/otel/README.md.
. "$(dirname "$0")/lib.sh"
Q="$1"; H="${2:-24}"; L="${3:-200}"
NOW=$(date +%s); START=$((NOW - H*3600))
grafana_curl /api/datasources/proxy/uid/tempo/api/search -G \
  --data-urlencode "q=$Q" \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$NOW" \
  --data-urlencode "limit=$L"
