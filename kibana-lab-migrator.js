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
        var r = await fetch(url, {method:'POST', headers:{'kbn-xsrf':'true','Content-Type':'application/json','x-elastic-internal-origin':'Kibana'},
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
    var info = await es('GET','/');
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
    var idx = ((r.data&&r.data.indices)||[]).map(function(x){ return x.name; });
    if (!includeSystem) idx = idx.filter(function(n){ return n[0] !== '.'; });
    var ds = ((r.data&&r.data.data_streams)||[]).map(function(x){ return x.name; });
    window.__klm_ds = {}; ds.forEach(function(n){ window.__klm_ds[n]=true; });
    return idx.concat(ds).sort();
  }
  async function analyze(idx){
    var out = {idx:idx, docs:0, dateFields:[], suggested:null, err:null, isDS:!!(window.__klm_ds&&window.__klm_ds[idx])};
    try{
      var cnt = await es('GET', idx+'/_count');
      out.docs = (cnt.data&&cnt.data.count)||0;
      if (out.isDS){
        var dd = await es('GET','_data_stream/'+idx);
        var e = dd.data&&dd.data.data_streams&&dd.data.data_streams[0];
        if (e){ out.suggested = e.timestamp_field&&e.timestamp_field.name; out.dsTemplate = e.template; out.dsIlm = e.ilm_policy||null;
          out.dateFields = [{field:out.suggested, count:out.docs, min:null, max:null}]; }
      }
      else { var fc = await es('GET', idx+'/_field_caps?fields=*&types=date');
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
      } }
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
      if (window.__klm_ds&&window.__klm_ds[indices[i]]) continue;
      var r = await es('GET', indices[i]+'/_mapping');
      maps[indices[i]] = (r.data[indices[i]]&&r.data[indices[i]].mappings)||{};
    }
    return maps;
  }
  async function pullTemplates(dsNames){
    var out={index_templates:{}, component_templates:{}, ilm:{}};
    for (var i=0;i<dsNames.length;i++){
      var dd = await es('GET','_data_stream/'+dsNames[i]);
      var e = dd.data&&dd.data.data_streams&&dd.data.data_streams[0]; if(!e) continue;
      var itR = await es('GET','_index_template/'+e.template);
      var it = itR.data.index_templates&&itR.data.index_templates[0]&&itR.data.index_templates[0].index_template;
      if (it){ out.index_templates[e.template]=it;
        var comps=it.composed_of||[];
        for (var c=0;c<comps.length;c++){ var cr=await es('GET','_component_template/'+comps[c]);
          var ct=cr.data.component_templates&&cr.data.component_templates[0]&&cr.data.component_templates[0].component_template;
          if(ct) out.component_templates[comps[c]]=ct; }
      }
      if (e.ilm_policy){ var ir=await es('GET','_ilm/policy/'+e.ilm_policy);
        if (ir.data[e.ilm_policy]) out.ilm[e.ilm_policy]=ir.data[e.ilm_policy]; }
    }
    return out;
  }

  /* ---------- bundle emitters (manifest + templates) ---------- */
  function buildManifest(plans){
    var lines=['# name\texpected_count\ttime_field\ttype\ttemplate'];
    plans.forEach(function(p){
      var a=p.analysis||{};
      var type = a.isDS ? 'data_stream' : 'index';
      var tf = p.timeField || '-';
      var tpl = a.dsTemplate || '';
      lines.push([p.idx, (a.docs||0), tf, type, tpl].join('\t'));
    });
    return lines.join('\n')+'\n';
  }

  /* ---------- panel UI ----------  /* ---------- panel UI ---------- */
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
      + "<button data-loader>Save bundle (manifest+templates)</button>"
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
      var dsSel=sel.filter(function(n){ return window.__klm_ds&&window.__klm_ds[n]; });
      S.templates = dsSel.length ? await pullTemplates(dsSel) : {index_templates:{},component_templates:{},ilm:{}};
      log('Exporting '+sel.length+' target(s)'+(dsSel.length?(' ('+dsSel.length+' data stream(s))'):'')+'. Allow multiple downloads if Chrome asks.');
      for (var i=0;i<S.plans.length;i++){
        try{
          await exportIndex(S.plans[i],
            function(name,phase,res){ if(phase==='start') log('  '+name+' ...');
              else log('  '+name+' '+(res.skipped?'(empty, skipped)':res.written.toLocaleString()+' docs, '+res.mb+' MB')+(res.expected&&res.written!==res.expected?' MISMATCH':''), res.expected&&res.written!==res.expected?'er':'ok'); },
            null);
        }catch(e){ log('  '+S.plans[i].idx+' FAILED: '+String(e).slice(0,160),'er'); }
      }
      saveBundle(S.plans, S.mappings, S.templates);
      log('Export complete. Bundle (manifest, mappings, templates) saved. Load with load_dataset.sh.','ok');
      setBusy(false);
    }
    function saveBundle(plans, mappings, templates){
      var cl=(S.who?S.who.cluster:'cluster');
      dl(new Blob([buildManifest(plans)],{type:'text/plain'}), 'manifest.txt');
      if (Object.keys(mappings).length) dl(new Blob([JSON.stringify(mappings,null,1)],{type:'application/json'}), 'mappings.json');
      if (templates){
        Object.keys(templates.index_templates||{}).forEach(function(k){ dl(new Blob([JSON.stringify(templates.index_templates[k],null,1)],{type:'application/json'}),'templates__index_template_'+k+'.json'); });
        Object.keys(templates.component_templates||{}).forEach(function(k){ dl(new Blob([JSON.stringify(templates.component_templates[k],null,1)],{type:'application/json'}),'templates__component_template_'+k+'.json'); });
        Object.keys(templates.ilm||{}).forEach(function(k){ dl(new Blob([JSON.stringify(templates.ilm[k],null,1)],{type:'application/json'}),'templates__ilm_'+k+'.json'); });
      }
    }
    async function doMaps(){
      var sel=chosenIndices(); if(!sel.length){ log('Select indices first.','er'); return; }
      setBusy(true); log('Pulling mappings for '+sel.length+' index(es)...');
      var m=await pullMappings(sel); S.mappings=m;
      dl(new Blob([JSON.stringify(m,null,2)],{type:'application/json'}), 'mappings_'+(S.who?S.who.cluster:'cluster')+'.json');
      log('Saved mappings JSON.','ok'); setBusy(false);
    }
    async function doBundle(){
      var sel=chosenIndices(); if(!sel.length){ log('Select targets first.','er'); return; }
      var missing=sel.filter(function(n){ return !S.analyses[n]; });
      if(missing.length){ log('Analyze first so counts+time fields are known.','er'); return; }
      setBusy(true);
      var plans=plansFrom(sel);
      var maps=Object.keys(S.mappings).length?S.mappings:await pullMappings(sel);
      var dsSel=sel.filter(function(n){ return window.__klm_ds&&window.__klm_ds[n]; });
      var templates=dsSel.length?await pullTemplates(dsSel):{index_templates:{},component_templates:{},ilm:{}};
      saveBundle(plans, maps, templates);
      log('Saved bundle: manifest.txt, mappings.json, templates. Run load_dataset.sh -d <dir>.','ok'); setBusy(false);
    }
    function setBusy(b){ S.busy=b; ['data-analyze','data-export','data-maps','data-loader'].forEach(function(k){ el.querySelector('['+k+']').disabled=b; }); }

    el.querySelector('[data-analyze]').onclick=doAnalyze;
    el.querySelector('[data-export]').onclick=doExport;
    el.querySelector('[data-maps]').onclick=doMaps;
    el.querySelector('[data-loader]').onclick=doBundle;

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
  if (typeof module !== 'undefined' && module.exports) module.exports = { buildManifest: buildManifest };
})();
