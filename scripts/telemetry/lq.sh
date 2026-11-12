#!/bin/sh
# lq.sh "<LogQL>" [hours_back] [limit]  -> Loki query_range JSON, newest first
# Loki's only indexed labels are service_instance_id and service_name.
. "$(dirname "$0")/lib.sh"
Q="$1"; H="${2:-24}"; L="${3:-500}"
NOW=$(date +%s); START=$((NOW - H*3600))
grafana_curl /api/datasources/proxy/uid/loki/loki/api/v1/query_range -G \
  --data-urlencode "query=$Q" \
  --data-urlencode "start=${START}000000000" \
  --data-urlencode "end=${NOW}000000000" \
  --data-urlencode "limit=$L" \
  --data-urlencode "direction=backward"
