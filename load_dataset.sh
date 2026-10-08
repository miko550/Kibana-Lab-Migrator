#!/usr/bin/env bash
# load_dataset.sh — restore a bundle produced by export_from_es.sh (or the
# Kibana Lab Migrator) onto a fresh Elastic 8.x/9.x cluster. Handles both plain
# indices and data streams.
#
# Bundle (in -d DIR):
#   *.ndjson.gz        exported docs
#   manifest.txt       name <tab> count <tab> time_field <tab> type <tab> template
#   mappings.json      {index: mappings} for plain indices
#   templates/         index_template_*.json, component_template_*.json, ilm_*.json
#
# Requires: bash 4+, curl, jq, gzip; elasticdump only if plain indices present.
#
# Usage:
#   ./load_dataset.sh -u https://es:9200 -k <API_KEY> -d ./out -i [-K https://kibana:5601]
#
# Options: -u URL(req)  -k KEY | -U USER [-P PASS]  -d DIR(req)  -K Kibana URL
#          -c CA | -i insecure  -f force-recreate  -r replicas(1)  -b batch(5000)  -h
set -euo pipefail
ES_URL="" API_KEY="" ES_USER="" ES_PASS="" DIR="" KB_URL="" KB_SPACE=""
CA_FILE="" INSECURE=0 FORCE=0 REPLICAS=1 BATCH=5000
usage(){ sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while getopts "u:k:U:P:d:K:S:c:ifr:b:h" o; do case $o in
  u) ES_URL=${OPTARG%/};; k) API_KEY=$OPTARG;; U) ES_USER=$OPTARG;; P) ES_PASS=$OPTARG;;
  d) DIR=$OPTARG;; K) KB_URL=${OPTARG%/};; S) KB_SPACE=$OPTARG;; c) CA_FILE=$OPTARG;;
  i) INSECURE=1;; f) FORCE=1;; r) REPLICAS=$OPTARG;; b) BATCH=$OPTARG;; h) usage 0;; *) usage 1;;
esac; done
log(){ printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die(){ printf '[%s] ERROR: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }
[[ -n $ES_URL && -n $DIR ]] || usage 1
for b in curl jq gzip; do command -v "$b" >/dev/null || die "'$b' not found"; done
[[ -f $DIR/manifest.txt ]] || die "No manifest.txt in $DIR"

if [[ -n $API_KEY ]]; then AUTH="ApiKey $API_KEY"
elif [[ -n $ES_USER ]]; then [[ -n $ES_PASS ]] || { read -rsp "Password for $ES_USER: " ES_PASS; echo; }
  AUTH="Basic $(printf '%s:%s' "$ES_USER" "$ES_PASS" | base64 | tr -d '\n')"
else die "Provide -k or -U"; fi
TLS=(); (( INSECURE )) && { TLS=(-k); export NODE_TLS_REJECT_UNAUTHORIZED=0; }
[[ -n $CA_FILE ]] && { TLS=(--cacert "$CA_FILE"); export NODE_EXTRA_CA_CERTS="$CA_FILE"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
es(){ local m=$1 p=$2 b=${3:-}
  local a=(-sS "${TLS[@]}" -X "$m" -H "Authorization: $AUTH" -H 'Content-Type: application/json' -o "$TMP/b" -w '%{http_code}')
  [[ -n $b ]] && a+=(--data-binary "$b")
  HTTP_CODE=$(curl "${a[@]}" "$ES_URL/$p" || echo 000); BODY=$(cat "$TMP/b" 2>/dev/null||true); }
esfile(){ local m=$1 p=$2 f=$3
  HTTP_CODE=$(curl -sS "${TLS[@]}" -X "$m" -H "Authorization: $AUTH" -H 'Content-Type: application/json' \
    --data-binary @"$f" -o "$TMP/b" -w '%{http_code}' "$ES_URL/$p" || echo 000); BODY=$(cat "$TMP/b" 2>/dev/null||true); }

es GET "/"; [[ $HTTP_CODE == 200 ]] || die "Connect/auth failed (HTTP $HTTP_CODE): $BODY"
log "Elasticsearch $(jq -r '.version.number' <<<"$BODY")  cluster: $(jq -r '.cluster_name' <<<"$BODY")"

# ---- parse manifest ----
declare -a NAMES; declare -A CNT TF TYPE TPL
while IFS=$'\t' read -r name count tf type tpl; do
  [[ -z $name || $name == \#* ]] && continue
  NAMES+=("$name"); CNT[$name]=$count; TF[$name]=$tf; TYPE[$name]=$type; TPL[$name]=$tpl
done < "$DIR/manifest.txt"
[[ ${#NAMES[@]} -gt 0 ]] || die "manifest has no entries"
log "Targets: ${NAMES[*]}"

files_for(){ ls "$DIR/$1".ndjson.gz "$DIR/$1"_[0-9]*.ndjson.gz 2>/dev/null | sort; }

# ---- bulk-create loader for data streams (curl, op=create) ----
bulk_create(){ local target=$1 file=$2 total=0 batch_n=0
  local line buf="" n=0
  while IFS= read -r line; do
    [[ -z $line ]] && continue
    buf+='{"create":{}}'$'\n'"$line"$'\n'; n=$((n+1))
    if (( n >= BATCH )); then
      printf '%s' "$buf" > "$TMP/bulk.ndjson"
      esfile POST "$target/_bulk" "$TMP/bulk.ndjson"
      [[ $HTTP_CODE == 200 ]] || die "bulk to $target HTTP $HTTP_CODE: ${BODY:0:200}"
      jq -e '.errors==false' <<<"$BODY" >/dev/null || { die "bulk errors into $target: $(jq -c '[.items[]|.create|select(.error)][0]' <<<"$BODY")"; }
      total=$((total+n)); n=0; buf=""
    fi
  done < <(gzip -dc "$file")
  if (( n > 0 )); then
    printf '%s' "$buf" > "$TMP/bulk.ndjson"
    esfile POST "$target/_bulk" "$TMP/bulk.ndjson"
    [[ $HTTP_CODE == 200 ]] || die "bulk to $target HTTP $HTTP_CODE: ${BODY:0:200}"
    jq -e '.errors==false' <<<"$BODY" >/dev/null || die "bulk errors into $target"
    total=$((total+n))
  fi
  echo "$total"
}

# ---- 1. templates (once, for any data streams) ----
if ls "$DIR"/templates/component_template_*.json >/dev/null 2>&1; then
  for f in "$DIR"/templates/component_template_*.json; do
    nm=$(basename "$f"); nm=${nm#component_template_}; nm=${nm%.json}
    esfile PUT "_component_template/$nm" "$f"; [[ $HTTP_CODE == 200 ]] || die "component_template $nm HTTP $HTTP_CODE: $BODY"
    log "component template $nm"
  done
fi
if ls "$DIR"/templates/ilm_*.json >/dev/null 2>&1; then
  for f in "$DIR"/templates/ilm_*.json; do
    nm=$(basename "$f"); nm=${nm#ilm_}; nm=${nm%.json}
    jq '{policy: .policy}' "$f" > "$TMP/ilm.json"
    esfile PUT "_ilm/policy/$nm" "$TMP/ilm.json"; [[ $HTTP_CODE == 200 ]] || log "WARN: ilm $nm HTTP $HTTP_CODE: $BODY"
    log "ilm policy $nm"
  done
fi
if ls "$DIR"/templates/index_template_*.json >/dev/null 2>&1; then
  for f in "$DIR"/templates/index_template_*.json; do
    nm=$(basename "$f"); nm=${nm#index_template_}; nm=${nm%.json}
    esfile PUT "_index_template/$nm" "$f"; [[ $HTTP_CODE == 200 ]] || die "index_template $nm HTTP $HTTP_CODE: $BODY"
    log "index template $nm"
  done
fi

# ---- 2. per target: create + load ----
fail=0
for name in "${NAMES[@]}"; do
  mapfile -t files < <(files_for "$name")
  [[ ${#files[@]} -gt 0 ]] || { log "WARN: no data files for $name, skipping"; continue; }

  if [[ ${TYPE[$name]} == data_stream ]]; then
    es GET "_data_stream/$name"
    if [[ $HTTP_CODE == 200 ]]; then
      (( FORCE )) || die "$name exists. Re-run with -f to recreate."
      log "$name exists — deleting (-f)"; es DELETE "_data_stream/$name"
    fi
    es PUT "_data_stream/$name"; [[ $HTTP_CODE == 200 ]] || die "create data stream $name HTTP $HTTP_CODE: $BODY"
    log "Created data stream $name"
    w=0; for f in "${files[@]}"; do log "  bulk-create $(basename "$f")"; w=$(( w + $(bulk_create "$name" "$f") )); done
    es POST "$name/_refresh" >/dev/null
  else
    es GET "$name"
    if [[ $HTTP_CODE == 200 ]]; then
      (( FORCE )) || die "$name exists. Re-run with -f to recreate."
      log "$name exists — deleting (-f)"; es DELETE "$name"
    fi
    jq --arg i "$name" '.[$i]' "$DIR/mappings.json" > "$TMP/m.json"
    [[ $(cat "$TMP/m.json") != null ]] || die "no mapping for $name in mappings.json"
    jq -n --slurpfile m "$TMP/m.json" '{settings:{number_of_shards:1,number_of_replicas:0,refresh_interval:"-1"},mappings:$m[0]}' > "$TMP/create.json"
    esfile PUT "$name" "$TMP/create.json"; [[ $HTTP_CODE == 200 ]] || die "create $name HTTP $HTTP_CODE: $BODY"
    log "Created index $name"
    if command -v elasticdump >/dev/null; then
      hdr=$(jq -cn --arg a "$AUTH" '{Authorization:$a}')
      for f in "${files[@]}"; do log "  load $(basename "$f")"
        gzip -dc "$f" | jq -c '{_source: .}' > "$TMP/chunk.json"
        elasticdump --input="$TMP/chunk.json" --output="$ES_URL/$name" --type=data --headers="$hdr" \
          --limit="$BATCH" --noRefresh --retryAttempts=5 --retryDelay=3000 > "$TMP/ed.log" 2>&1 \
          || { tail -15 "$TMP/ed.log"; die "elasticdump failed on $f"; }
      done
    else
      log "  elasticdump not found — using curl bulk"
      w=0; for f in "${files[@]}"; do w=$(( w + $(bulk_create "$name" "$f") )); done
    fi
    es PUT "$name/_settings" "{\"index\":{\"number_of_replicas\":$REPLICAS,\"refresh_interval\":\"1s\"}}" >/dev/null
    es POST "$name/_refresh" >/dev/null
  fi
done

# ---- 3. verify ----
printf '\n%-28s %12s %12s  %-11s %s\n' NAME EXPECTED ACTUAL TYPE STATUS
for name in "${NAMES[@]}"; do
  es GET "$name/_count"; c=$(jq -r '.count // "ERR"' <<<"$BODY")
  st=OK; [[ $c == "${CNT[$name]}" ]] || { st=MISMATCH; fail=1; }
  printf '%-28s %12s %12s  %-11s %s\n' "$name" "${CNT[$name]}" "$c" "${TYPE[$name]}" "$st"
done
echo

# ---- 4. data views ----
if [[ -n $KB_URL ]]; then
  sp=""; [[ -n $KB_SPACE ]] && sp="/s/$KB_SPACE"
  for name in "${NAMES[@]}"; do
    tf=${TF[$name]:--}
    if [[ -n $tf && $tf != "-" ]]; then dv="{\"data_view\":{\"title\":\"$name\",\"name\":\"$name\",\"timeFieldName\":\"$tf\"},\"override\":true}"
    else dv="{\"data_view\":{\"title\":\"$name\",\"name\":\"$name\"},\"override\":true}"; fi
    code=$(curl -sS "${TLS[@]}" -o /dev/null -w '%{http_code}' -X POST \
      -H "Authorization: $AUTH" -H 'kbn-xsrf: true' -H 'x-elastic-internal-origin: Kibana' -H 'Content-Type: application/json' \
      "$KB_URL$sp/api/data_views/data_view" -d "$dv")
    log "data view $name (time=$tf): HTTP $code"
  done
fi
(( fail == 0 )) && log "Done — dataset ready to search." || die "Count mismatch — see table."
