/* Kibana Lab Migrator — read-only export tool.
   Paste into the browser DevTools Console on a Kibana tab (F12 -> Console),
   or run as the bookmarklet build. Works in any space; uses only the Kibana
   console proxy, so it needs no API access beyond your Kibana login.
   It never writes to or deletes from the source cluster. */
(function(){
  if (typeof window !== 'undefined' && window.__klm && window.__klm.panel) {
    window.__klm.panel.style.display = (window.__klm.panel.style.display==='none'?'flex':'none');
    return;
  }
  var LOADER_TEMPLATE = "#!/usr/bin/env bash\n# GENERATED loader \u2014 recreate an exported dataset on a fresh Elastic 8.x cluster.\n# Creates 5 indices with verified source mappings, bulk-loads the 23 exported\n# *.ndjson.gz files with elasticdump, restores settings, verifies counts,\n# and (optionally) creates Kibana data views with time field \"timestamp\".\n#\n# Requires: bash 4+, curl, jq, gzip, elasticdump (npm i -g elasticdump)\n#\n# Usage:\n#   ./load_hunt_dataset.sh -u https://es:9200 -k <API_KEY> [-d ./exports] [-K https://kibana:5601]\n#   ./load_hunt_dataset.sh -u https://es:9200 -U elastic [-P pass] ...     (prompts if -P omitted)\n#\n# Options:\n#   -u URL     Elasticsearch URL (required)\n#   -k KEY     API key (base64 \"id:key\" encoded form, as returned in \"encoded\")\n#   -U USER    Basic-auth username (alternative to -k)\n#   -P PASS    Basic-auth password (prompted if omitted)\n#   -d DIR     Directory containing the .ndjson.gz files (default: current dir)\n#   -K URL     Kibana URL \u2014 if set, creates data views\n#   -S SPACE   Kibana space for data views (default: default space)\n#   -c FILE    CA certificate for TLS verification\n#   -i         Insecure: skip TLS verification (self-signed lab clusters)\n#   -f         Force: delete and recreate indices that already exist\n#   -r N       Replicas after load (default: 1; use 0 for single-node)\n#   -b N       elasticdump batch size (default: 5000)\n#   -h         Help\nset -euo pipefail\n\nES_URL=\"\" API_KEY=\"\" ES_USER=\"\" ES_PASS=\"\" DATA_DIR=\".\" KB_URL=\"\" KB_SPACE=\"\"\nCA_FILE=\"\" INSECURE=0 FORCE=0 REPLICAS=1 BATCH=5000\n\nusage() { sed -n '2,27p' \"$0\" | sed 's/^# \\{0,1\\}//'; exit \"${1:-0}\"; }\nwhile getopts \"u:k:U:P:d:K:S:c:ifr:b:h\" o; do\n  case $o in\n    u) ES_URL=${OPTARG%/};; k) API_KEY=$OPTARG;; U) ES_USER=$OPTARG;; P) ES_PASS=$OPTARG;;\n    d) DATA_DIR=$OPTARG;; K) KB_URL=${OPTARG%/};; S) KB_SPACE=$OPTARG;; c) CA_FILE=$OPTARG;;\n    i) INSECURE=1;; f) FORCE=1;; r) REPLICAS=$OPTARG;; b) BATCH=$OPTARG;; h) usage 0;; *) usage 1;;\n  esac\ndone\n\nlog()  { printf '[%s] %s\\n' \"$(date +%H:%M:%S)\" \"$*\"; }\ndie()  { printf '[%s] ERROR: %s\\n' \"$(date +%H:%M:%S)\" \"$*\" >&2; exit 1; }\n\n# ---------- preflight ----------\n[[ -n $ES_URL ]] || { echo \"Missing -u\"; usage 1; }\nfor b in curl jq gzip elasticdump; do command -v \"$b\" >/dev/null || die \"'$b' not found in PATH\"; done\n\nif [[ -n $API_KEY ]]; then\n  AUTH=\"ApiKey $API_KEY\"\nelif [[ -n $ES_USER ]]; then\n  [[ -n $ES_PASS ]] || { read -rsp \"Password for $ES_USER: \" ES_PASS; echo; }\n  AUTH=\"Basic $(printf '%s:%s' \"$ES_USER\" \"$ES_PASS\" | base64 | tr -d '\\n')\"\nelse\n  die \"Provide -k API_KEY or -U USER\"\nfi\n\nCURL_TLS=()\nif (( INSECURE )); then CURL_TLS=(-k); export NODE_TLS_REJECT_UNAUTHORIZED=0\nelif [[ -n $CA_FILE ]]; then CURL_TLS=(--cacert \"$CA_FILE\"); export NODE_EXTRA_CA_CERTS=\"$CA_FILE\"; fi\n\n# es METHOD PATH [JSON_BODY] -> sets globals BODY and HTTP_CODE (no subshell)\nTMP=$(mktemp -d); trap 'rm -rf \"$TMP\"' EXIT\nes() {\n  local m=$1 p=$2 b=${3:-}\n  local args=(-sS ${CURL_TLS[@]+\"${CURL_TLS[@]}\"} -X \"$m\" -H \"Authorization: $AUTH\" -H 'Content-Type: application/json' -o \"$TMP/body\" -w '%{http_code}')\n  [[ -n $b ]] && args+=(--data-binary \"$b\")\n  HTTP_CODE=$(curl \"${args[@]}\" \"$ES_URL/$p\") || HTTP_CODE=000\n  BODY=$(cat \"$TMP/body\" 2>/dev/null || true)\n}\n\ndeclare -A EXPECTED=( @@EXPECTED@@ )\ndeclare -A TIMEFIELD=( @@TIMEFIELDS@@ )\nINDICES=( @@INDICES@@ )\n\n@@MAPS@@\n\nlog \"Connecting to $ES_URL\"\nes GET \"\"\n[[ $HTTP_CODE != 000 ]] || die \"Cannot reach $ES_URL\"\n[[ $HTTP_CODE == 200 ]] || die \"Auth/connection failed (HTTP $HTTP_CODE): $BODY\"\nver=$(jq -r '.version.number' <<<\"$BODY\")\nlog \"Elasticsearch $ver\"\n[[ ${ver%%.*} -ge 8 ]] || die \"Elasticsearch 8.x+ required (found $ver)\"\n\n# check data files\nmissing=0\nfor idx in \"${INDICES[@]}\"; do\n  n=$(ls \"$DATA_DIR\"/${idx}.ndjson.gz \"$DATA_DIR\"/${idx}_[0-9]*.ndjson.gz 2>/dev/null | wc -l || true)\n  (( n > 0 )) || { log \"MISSING: no files for $idx in $DATA_DIR\"; missing=1; }\ndone\n(( missing == 0 )) || die \"Data files missing \u2014 check -d\"\n\n# ---------- 1. create indices ----------\nfor idx in \"${INDICES[@]}\"; do\n  es GET \"$idx\"\n  if [[ $HTTP_CODE == 200 ]]; then\n    if (( FORCE )); then log \"$idx exists \u2014 deleting (-f)\"; es DELETE \"$idx\"\n    else die \"$idx already exists on target. Re-run with -f to delete and recreate.\"; fi\n  fi\n  map_var=\"MAP_$idx\"\n  body=$(jq -c --argjson m \"${!map_var}\" -n \\\n    '{settings:{number_of_shards:1,number_of_replicas:0,refresh_interval:\"-1\"},mappings:$m}')\n  es PUT \"$idx\" \"$body\"\n  [[ $HTTP_CODE == 200 ]] || die \"Create $idx failed (HTTP $HTTP_CODE): $BODY\"\n  log \"Created $idx\"\ndone\n\n# ---------- 2. load data ----------\nED_HEADERS=$(jq -cn --arg a \"$AUTH\" '{Authorization:$a}')\n\nfor idx in \"${INDICES[@]}\"; do\n  # match logs_edr_2026-..gz / logs_edr.ndjson.gz but not logs_edr_something_else\n  mapfile -t files < <(ls \"$DATA_DIR\"/${idx}.ndjson.gz \"$DATA_DIR\"/${idx}_[0-9]*.ndjson.gz 2>/dev/null | sort)\n  for f in \"${files[@]}\"; do\n    log \"Loading $(basename \"$f\") -> $idx\"\n    gzip -dc \"$f\" | jq -c '{_source: .}' > \"$TMP/chunk.json\"\n    elasticdump \\\n      --input=\"$TMP/chunk.json\" \\\n      --output=\"$ES_URL/$idx\" \\\n      --type=data \\\n      --headers=\"$ED_HEADERS\" \\\n      --limit=\"$BATCH\" \\\n      --noRefresh \\\n      --retryAttempts=5 --retryDelay=3000 \\\n      > \"$TMP/ed.log\" 2>&1 || { tail -20 \"$TMP/ed.log\"; die \"elasticdump failed on $f\"; }\n    tail -1 \"$TMP/ed.log\"\n  done\ndone\n\n# ---------- 3. restore settings ----------\nfor idx in \"${INDICES[@]}\"; do\n  es PUT \"$idx/_settings\" \"{\\\"index\\\":{\\\"number_of_replicas\\\":$REPLICAS,\\\"refresh_interval\\\":\\\"1s\\\"}}\"\n  [[ $HTTP_CODE == 200 ]] || log \"WARN: settings on $idx HTTP $HTTP_CODE: $BODY\"\n  es POST \"$idx/_refresh\"\ndone\nlog \"Settings restored (replicas=$REPLICAS, refresh=1s)\"\n\n# ---------- 4. verify ----------\nfail=0\nprintf '\\n%-20s %12s %12s  %s\\n' INDEX EXPECTED ACTUAL STATUS\nfor idx in \"${INDICES[@]}\"; do\n  es GET \"$idx/_count\"; c=$(jq -r '.count' <<<\"$BODY\")\n  st=OK; [[ $c == \"${EXPECTED[$idx]}\" ]] || { st=MISMATCH; fail=1; }\n  printf '%-20s %12s %12s  %s\\n' \"$idx\" \"${EXPECTED[$idx]}\" \"$c\" \"$st\"\ndone\necho\n\n# ---------- 5. Kibana data views (optional) ----------\nif [[ -n $KB_URL ]]; then\n  sp=\"\"; [[ -n $KB_SPACE ]] && sp=\"/s/$KB_SPACE\"\n  for idx in \"${INDICES[@]}\"; do\n    tf=${TIMEFIELD[$idx]:--}\n    if [[ -n $tf && $tf != \"-\" ]]; then\n      dv=\"{\\\"data_view\\\":{\\\"title\\\":\\\"$idx\\\",\\\"name\\\":\\\"$idx\\\",\\\"timeFieldName\\\":\\\"$tf\\\"},\\\"override\\\":true}\"\n    else\n      dv=\"{\\\"data_view\\\":{\\\"title\\\":\\\"$idx\\\",\\\"name\\\":\\\"$idx\\\"},\\\"override\\\":true}\"\n    fi\n    code=$(curl -sS ${CURL_TLS[@]+\"${CURL_TLS[@]}\"} -o /dev/null -w '%{http_code}' -X POST \\\n      -H \"Authorization: $AUTH\" -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \\\n      \"$KB_URL$sp/api/data_views/data_view\" -d \"$dv\")\n    log \"Data view $idx (time=$tf): HTTP $code\"\n  done\nfi\n\n(( fail == 0 )) && log \"Done \u2014 dataset ready to search.\" || die \"Count mismatch \u2014 see table above.\"\n";

  /* ---------- cluster access via the Kibana console proxy ---------- */
  function prefix(){
    var p = location.pathname, i = p.indexOf('/app/');
    return i >= 0 ? p.slice(0, i) : '';
  }
  function spaceOf(){
    var m = location.pathname.match(/\/s\/([^\/]+)\//);
    return m ? m[1] : '';
  }
  async function es(method, path, body){
    var url = prefix() + '/api/console/proxy?path=' + encodeURIComponent(path) + '&method=' + method;
    for (var a=0;a<4;a++){
      try{
        var r = await fetch(url, {method:'POST', headers:{'kbn-xsrf':'true','Content-Type':'application/json'},
          body: body!==undefined ? JSON.stringify(body) : undefined});
        var t = await r.text();
        if (r.status>=500 || r.status===429) throw new Error(r.status+' '+t.slice(0,200));
        var j; try{ j=JSON.parse(t); }catch(e){ j=t; }
        return {status:r.status, data:j};
      }catch(e){ if(a===3) throw e; await sleep(1500*(a+1)); }
    }
  }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }

  /* ---------- discovery ---------- */
  async function whoami(){
    var info = await es('GET','');
    var me = await es('GET','_security/_authenticate').catch(function(){ return {data:{}}; });
    return {
      cluster: (info.data&&info.data.cluster_name)||'(unknown)',
      version: (info.data&&info.data.version&&info.data.version.number)||'?',
      user: (me.data&&me.data.username)||'(unknown)',
      roles: (me.data&&me.data.roles)||[]
    };
  }
  async function listIndices(includeSystem){
    var r = await es('GET','_resolve/index/*');
    var names = ((r.data&&r.data.indices)||[]).map(function(x){ return x.name; });
    if (!includeSystem) names = names.filter(function(n){ return n[0] !== '.'; });
    return names.sort();
  }
  async function analyze(idx){
    var out = {idx:idx, docs:0, dateFields:[], suggested:null, err:null};
    try{
      var cnt = await es('GET', idx+'/_count');
      out.docs = (cnt.data&&cnt.data.count)||0;
      var fc = await es('GET', idx+'/_field_caps?fields=*&types=date');
      var fields = Object.keys((fc.data&&fc.data.fields)||{});
      if (fields.length){
        var aggs={}; fields.forEach(function(f,n){ aggs['c'+n]={value_count:{field:f}}; aggs['mn'+n]={min:{field:f}}; aggs['mx'+n]={max:{field:f}}; });
        var s = await es('POST', idx+'/_search', {size:0, aggs:aggs});
        var A=(s.data&&s.data.aggregations)||{};
        out.dateFields = fields.map(function(f,n){
          return {field:f, count:(A['c'+n]||{}).value||0,
                  min:(A['mn'+n]||{}).value_as_string||null, max:(A['mx'+n]||{}).value_as_string||null};
        });
        var populated = out.dateFields.filter(function(d){ return d.count>0; });
        out.suggested = populated.length ? populated[0].field : null;
      }
    }catch(e){ out.err = String(e).slice(0,200); }
    return out;
  }

  /* ---------- export (PIT + search_after -> gzipped NDJSON) ---------- */
  function ymd(ms){ return new Date(ms).toISOString().slice(0,10); }
  function dl(blob, name){
    var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 60000);
  }
  async function exportSlice(idx, query, sort, name, onProg){
    var expected = (await es('POST', idx+'/_count', {query:query})).data.count;
    if (!expected) return {name:name, expected:0, written:0, skipped:true};
    var pit = (await es('POST', idx+'/_pit?keep_alive=5m')).data.id;
    var cs = new CompressionStream('gzip'), w = cs.writable.getWriter();
    var blobP = new Response(cs.readable).blob(), enc = new TextEncoder();
    var after=null, written=0;
    try{
      while(true){
        var body={size:5000, pit:{id:pit,keep_alive:'5m'}, sort:sort, query:query, track_total_hits:false};
        if(after) body.search_after=after;
        var r = await es('POST','_search?filter_path=pit_id,hits.hits._source,hits.hits.sort,error', body);
        if (r.data.error) throw new Error(JSON.stringify(r.data.error).slice(0,200));
        pit = r.data.pit_id || pit;
        var hits = (r.data.hits&&r.data.hits.hits)||[];
        if (!hits.length) break;
        await w.write(enc.encode(hits.map(function(h){ return JSON.stringify(h._source); }).join('\n')+'\n'));
        written += hits.length; after = hits[hits.length-1].sort;
        if (onProg) onProg(written, expected);
      }
      await w.close();
    }catch(e){ try{ await w.abort(); }catch(_){}; await es('DELETE','_pit',{id:pit}).catch(function(){}); throw e; }
    var blob = await blobP;
    await es('DELETE','_pit',{id:pit}).catch(function(){});
    dl(blob, name);
    return {name:name, expected:expected, written:written, mb:+(blob.size/1048576).toFixed(2)};
  }
  async function exportIndex(plan, onFile, onProg){
    var idx=plan.idx, tf=plan.timeField, results=[];
    if (tf){
      var a = plan.analysis.dateFields.filter(function(d){ return d.field===tf; })[0];
      var minMs = a&&a.min ? Date.parse(a.min) : null, maxMs = a&&a.max ? Date.parse(a.max) : null;
      if (minMs===null){ tf=null; }
      else {
        var day=86400000, start=Math.floor(minMs/day)*day;
        for (var t=start; t<=maxMs; t+=day){
          var s=new Date(t).toISOString(), e=new Date(t+day).toISOString();
          var q={range:{}}; q.range[tf]={gte:s, lt:e};
          var name = idx+'_'+ymd(t)+'.ndjson.gz';
          onFile(name,'start');
          var res = await exportSlice(idx, q, [defSort(tf)], name, onProg);
          results.push(res); onFile(name,'done',res);
        }
        return results;
      }
    }
    var name2 = idx+'.ndjson.gz';
    onFile(name2,'start');
    var res2 = await exportSlice(idx, {match_all:{}}, [{_shard_doc:'asc'}], name2, onProg);
    results.push(res2); onFile(name2,'done',res2);
    return results;
  }
  function defSort(tf){ var o={}; o[tf]='asc'; return o; }

  async function pullMappings(indices){
    var maps={};
    for (var i=0;i<indices.length;i++){
      var r = await es('GET', indices[i]+'/_mapping');
      maps[indices[i]] = (r.data[indices[i]]&&r.data[indices[i]].mappings)||{};
    }
    return maps;
  }

  /* ---------- loader script generation (fills the tested template) ---------- */
  function buildLoaderScript(plans, mappings, counts){
    var order = plans.map(function(p){ return p.idx; });
    var maps = order.map(function(i){
      return "read -r -d '' MAP_"+i+" <<'JSON' || true\n"+JSON.stringify(mappings[i])+"\nJSON";
    }).join('\n');
    var expected = order.map(function(i){ return '['+i+']='+counts[i]; }).join(' ');
    var timefields = plans.map(function(p){ return '['+p.idx+']="'+(p.timeField||'-')+'"'; }).join(' ');
    return LOADER_TEMPLATE
      .replace('@@MAPS@@', maps)
      .replace('@@EXPECTED@@', expected)
      .replace('@@TIMEFIELDS@@', timefields)
      .replace('@@INDICES@@', order.join(' '));
  }

  /* ---------- panel UI ---------- */
  function initPanel(){
    var S = { indices:[], selected:{}, analyses:{}, plans:[], mappings:{}, counts:{}, busy:false };
    window.__klm = window.__klm || {};
    var css = document.createElement('style');
    css.textContent = ""
      + ".klm{position:fixed;top:16px;right:16px;width:420px;max-height:88vh;z-index:2147483647;"
      + "display:flex;flex-direction:column;background:#12161c;color:#dfe6ee;border:1px solid #2b3440;"
      + "border-radius:10px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 12px 40px rgba(0,0,0,.5)}"
      + ".klm *{box-sizing:border-box}"
      + ".klm header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;"
      + "border-bottom:1px solid #2b3440;cursor:move}"
      + ".klm h1{margin:0;font-size:13px;font-weight:600;letter-spacing:.02em;color:#e8f0f8}"
      + ".klm .x{cursor:pointer;color:#7d8a99;padding:2px 6px}.klm .x:hover{color:#dfe6ee}"
      + ".klm .who{padding:10px 14px;border-bottom:1px solid #2b3440;font-size:12px;background:#0e1319}"
      + ".klm .who b{color:#9fd3ff}.klm .who .warn{color:#ffcf70}"
      + ".klm .body{overflow:auto;padding:10px 14px}"
      + ".klm .row{display:flex;align-items:center;gap:8px;padding:3px 0}"
      + ".klm .row label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}"
      + ".klm .muted{color:#7d8a99}"
      + ".klm select{background:#0e1319;color:#dfe6ee;border:1px solid #2b3440;border-radius:5px;padding:2px 4px;font:inherit;max-width:150px}"
      + ".klm .bar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px;border-top:1px solid #2b3440}"
      + ".klm button{background:#1b2430;border:1px solid #33455a;color:#dfe6ee;border-radius:6px;"
      + "padding:6px 10px;font:inherit;cursor:pointer}"
      + ".klm button:hover{background:#243244}.klm button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}"
      + ".klm button.primary:hover{background:#2a7cff}.klm button:disabled{opacity:.5;cursor:default}"
      + ".klm .log{font-size:12px;white-space:pre-wrap;word-break:break-word;padding:8px 14px;border-top:1px solid #2b3440;max-height:150px;overflow:auto;color:#a8b6c6}"
      + ".klm .ok{color:#5fd08a}.klm .er{color:#ff8a8a}";
    document.head.appendChild(css);

    var el = document.createElement('div'); el.className='klm';
    el.innerHTML = ""
      + "<header><h1>Kibana Lab Migrator</h1><span class='x' data-x>close</span></header>"
      + "<div class='who' data-who>Connecting...</div>"
      + "<div class='body' data-body><div class='muted'>Loading indices...</div></div>"
      + "<div class='bar'>"
      + "<button data-analyze>Analyze selected</button>"
      + "<button data-export class='primary'>Export</button>"
      + "<button data-maps>Save mappings</button>"
      + "<button data-loader>Generate loader</button>"
      + "</div><div class='log' data-log></div>";
    document.body.appendChild(el);
    window.__klm.panel = el;

    var body=el.querySelector('[data-body]'), logEl=el.querySelector('[data-log]'), whoEl=el.querySelector('[data-who]');
    function log(msg, cls){ var d=document.createElement('div'); if(cls)d.className=cls; d.textContent=msg; logEl.appendChild(d); logEl.scrollTop=logEl.scrollHeight; }
    el.querySelector('[data-x]').onclick=function(){ el.style.display='none'; };

    /* drag */
    (function(){ var h=el.querySelector('header'),dx=0,dy=0,drag=false;
      h.onmousedown=function(e){ if(e.target.hasAttribute('data-x'))return; drag=true; dx=e.clientX-el.offsetLeft; dy=e.clientY-el.offsetTop; e.preventDefault(); };
      document.addEventListener('mousemove',function(e){ if(!drag)return; el.style.left=(e.clientX-dx)+'px'; el.style.top=(e.clientY-dy)+'px'; el.style.right='auto'; });
      document.addEventListener('mouseup',function(){ drag=false; }); })();

    function renderList(){
      body.innerHTML='';
      var top=document.createElement('div'); top.className='row muted';
      top.innerHTML="<label><input type='checkbox' data-all> select all ("+S.indices.length+" indices, space: "+(spaceOf()||'default')+")</label>";
      body.appendChild(top);
      top.querySelector('[data-all]').onchange=function(e){
        S.indices.forEach(function(n){ S.selected[n]=e.target.checked; });
        renderList();
      };
      S.indices.forEach(function(n){
        var r=document.createElement('div'); r.className='row';
        var a=S.analyses[n];
        var meta = a ? ("<span class='muted'>"+a.docs.toLocaleString()+" docs</span>") : "";
        r.innerHTML="<label><input type='checkbox' "+(S.selected[n]?'checked':'')+"> "+n+"</label>"+meta;
        r.querySelector('input').onchange=function(e){ S.selected[n]=e.target.checked; };
        body.appendChild(r);
        if (a && a.dateFields.length){
          var r2=document.createElement('div'); r2.className='row';
          var opts="<option value=''>(no time field / whole index)</option>";
          a.dateFields.forEach(function(d){
            var lbl=d.field+' ('+d.count.toLocaleString()+(d.count?', '+(d.min||'').slice(0,10)+'..'+(d.max||'').slice(0,10):' empty')+')';
            opts+="<option value='"+d.field+"' "+(a.chosen===d.field?'selected':'')+">"+lbl+"</option>";
          });
          r2.innerHTML="<label class='muted'>&nbsp;&nbsp;time field</label><select>"+opts+"</select>";
          r2.querySelector('select').onchange=function(e){ a.chosen=e.target.value||null; };
          body.appendChild(r2);
        }
      });
    }
    function chosenIndices(){ return S.indices.filter(function(n){ return S.selected[n]; }); }

    async function doAnalyze(){
      var sel=chosenIndices(); if(!sel.length){ log('Select at least one index first.','er'); return; }
      setBusy(true); log('Analyzing '+sel.length+' index(es)...');
      for (var i=0;i<sel.length;i++){
        var a=await analyze(sel[i]); a.chosen=a.suggested; S.analyses[sel[i]]=a; S.counts[sel[i]]=a.docs;
        if(a.err) log(sel[i]+': '+a.err,'er');
        else log(sel[i]+': '+a.docs.toLocaleString()+' docs, time='+(a.suggested||'(none)')+(a.suggested?'':' — confirm below'));
        renderList();
      }
      log('Analysis done. Review the time field per index, then Export.','ok');
      setBusy(false);
    }
    function plansFrom(sel){
      return sel.map(function(n){ var a=S.analyses[n]; return {idx:n, timeField:(a?a.chosen:null), analysis:a}; });
    }
    async function doExport(){
      var sel=chosenIndices(); if(!sel.length){ log('Select indices first.','er'); return; }
      var missing=sel.filter(function(n){ return !S.analyses[n]; });
      if(missing.length){ log('Analyze first (missing: '+missing.join(', ')+')','er'); return; }
      setBusy(true);
      S.plans=plansFrom(sel); S.mappings=await pullMappings(sel);
      log('Exporting '+sel.length+' index(es). Allow multiple downloads if Chrome asks.');
      for (var i=0;i<S.plans.length;i++){
        try{
          await exportIndex(S.plans[i],
            function(name,phase,res){ if(phase==='start') log('  '+name+' ...');
              else log('  '+name+' '+(res.skipped?'(empty, skipped)':res.written.toLocaleString()+' docs, '+res.mb+' MB')+(res.expected&&res.written!==res.expected?' MISMATCH':''), res.expected&&res.written!==res.expected?'er':'ok'); },
            null);
        }catch(e){ log('  '+S.plans[i].idx+' FAILED: '+String(e).slice(0,160),'er'); }
      }
      log('Export complete. '+sel.length+' index(es).','ok');
      setBusy(false);
    }
    async function doMaps(){
      var sel=chosenIndices(); if(!sel.length){ log('Select indices first.','er'); return; }
      setBusy(true); log('Pulling mappings for '+sel.length+' index(es)...');
      var m=await pullMappings(sel); S.mappings=m;
      dl(new Blob([JSON.stringify(m,null,2)],{type:'application/json'}), 'mappings_'+(S.who?S.who.cluster:'cluster')+'.json');
      log('Saved mappings JSON.','ok'); setBusy(false);
    }
    async function doLoader(){
      var sel=chosenIndices(); if(!sel.length){ log('Select indices first.','er'); return; }
      var missing=sel.filter(function(n){ return !S.analyses[n]; });
      if(missing.length){ log('Analyze first so counts+time fields are known.','er'); return; }
      setBusy(true);
      var plans=plansFrom(sel), maps=Object.keys(S.mappings).length?S.mappings:await pullMappings(sel);
      var counts={}; sel.forEach(function(n){ counts[n]=S.analyses[n].docs; });
      var script=buildLoaderScript(plans, maps, counts);
      dl(new Blob([script],{type:'text/x-sh'}), 'load_'+(S.who?S.who.cluster:'cluster')+'.sh');
      log('Saved loader script (chmod +x, then run against the target).','ok'); setBusy(false);
    }
    function setBusy(b){ S.busy=b; ['data-analyze','data-export','data-maps','data-loader'].forEach(function(k){ el.querySelector('['+k+']').disabled=b; }); }

    el.querySelector('[data-analyze]').onclick=doAnalyze;
    el.querySelector('[data-export]').onclick=doExport;
    el.querySelector('[data-maps]').onclick=doMaps;
    el.querySelector('[data-loader]').onclick=doLoader;

    (async function(){
      try{
        var w=await whoami(); S.who=w;
        whoEl.innerHTML="cluster <b>"+w.cluster+"</b> · ES "+w.version+" · user <b>"+w.user+"</b> ("+(w.roles.join(',')||'?')+")"
          +"<br><span class='warn'>Confirm this is the correct lab before exporting.</span>";
        S.indices=await listIndices(false);
        S.indices.forEach(function(n){ S.selected[n]=false; });
        renderList();
      }catch(e){ whoEl.innerHTML="<span class='warn'>Not connected: "+String(e).slice(0,120)+"</span>"; }
    })();
  }

  if (typeof window !== 'undefined') initPanel();
  if (typeof module !== 'undefined' && module.exports) module.exports = { buildLoaderScript: buildLoaderScript };
})();
