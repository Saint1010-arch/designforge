(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const LS = "designforge.cfg";
  const store = {
    get(){ try{ return localStorage.getItem(LS); }catch{ return null; } },
    set(v){ try{ localStorage.setItem(LS, v); }catch{} }
  };

  // ---- config (BYOK, localStorage only) ----
  let cfg = { apiKey:"", model:"gpt-4o-mini", baseUrl:"", maxTokens:16384 };
  try { cfg = { ...cfg, ...JSON.parse(store.get() || "{}") }; } catch {}
  function refreshKeyBtn(){
    const set = !!cfg.apiKey;
    $("#keyToggle").classList.toggle("set", set);
    $("#keyStatus").textContent = set ? "Key 已设置 · " + (cfg.model||"gpt-4o-mini") : "设置 API Key";
  }
  refreshKeyBtn();

  // ---- modal ----
  const modal = $("#keyModal");
  function openModal(){
    $("#apiKey").value=cfg.apiKey;
    $("#model").value=cfg.model;
    $("#baseUrl").value=cfg.baseUrl;
    if($("#maxTokens")) $("#maxTokens").value = cfg.maxTokens || 16384;
    syncModelSelect(cfg.model);
    modal.classList.remove("hidden");
  }
  function closeModal(){ modal.classList.add("hidden"); }
  $("#keyToggle").onclick = openModal;
  $("#keyCancel").onclick = closeModal;
  modal.onclick = (e)=>{ if(e.target===modal) closeModal(); };
  $("#keySave").onclick = () => {
    const model = ($("#model").value.trim() || $("#modelSelect").value.trim() || "gpt-4o-mini");
    var mt = $("#maxTokens") ? parseInt($("#maxTokens").value, 10) : 16384; if(!(mt>=1024 && mt<=65536)) mt = 16384;
    cfg = { apiKey:$("#apiKey").value.trim(), model, baseUrl:$("#baseUrl").value.trim(), maxTokens: mt };
    store.set(JSON.stringify(cfg));
    refreshKeyBtn(); closeModal();
  };

  // ---- model dropdown ----
  function syncModelSelect(selected){
    const sel = $("#modelSelect");
    if(selected){
      const has = $$("option", sel).some(o=>o.value===selected);
      if(has) sel.value = selected;
    }
  }
  $("#modelSelect").onchange = () => {
    const v = $("#modelSelect").value;
    if(v) $("#model").value = v;
  };
  $("#fetchModels").onclick = async () => {
    const btn = $("#fetchModels");
    const hint = $("#modelHint");
    const apiKey = $("#apiKey").value.trim();
    const baseUrl = $("#baseUrl").value.trim();
    if(!apiKey){ hint.textContent="请先填入 API Key 再拉取。"; hint.className="hint err-text"; return; }
    btn.disabled=true; const old=btn.textContent; btn.textContent="拉取中…";
    hint.textContent="正在向接口请求模型列表…"; hint.className="hint";
    try{
      const res = await fetch("/api/models", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ apiKey, baseUrl }) });
      const data = await res.json();
      if(data.error){ hint.textContent="拉取失败："+data.error; hint.className="hint err-text"; return; }
      const models = data.models || [];
      const sel = $("#modelSelect");
      sel.innerHTML = '<option value="">（选择一个模型）</option>' + models.map(m=>'<option value="'+m.replace(/"/g,"&quot;")+'">'+m+'</option>').join("");
      if(models.length){
        const prefer = models.find(m=>/gpt-4o-mini/i.test(m)) || models.find(m=>/gpt-4o/i.test(m)) || models[0];
        sel.value = prefer; $("#model").value = prefer;
        hint.textContent="已拉取 "+models.length+" 个模型，可在下拉中选择。"; hint.className="hint ok-text";
      } else {
        hint.textContent="接口返回空列表，请手动填写模型名。"; hint.className="hint err-text";
      }
    }catch(e){
      hint.textContent="拉取出错："+(e&&e.message||e); hint.className="hint err-text";
    }finally{
      btn.disabled=false; btn.textContent=old;
    }
  };

  // ---- tabs ----
  $$(".tab").forEach(t => t.onclick = () => {
    $$(".tab").forEach(x=>x.classList.remove("active"));
    $$(".panel").forEach(x=>x.classList.remove("active"));
    t.classList.add("active");
    $("#panel-"+t.dataset.tab).classList.add("active");
  });

  // ---- helpers ----
  function needKey(){ if(!cfg.apiKey){ openModal(); return true; } return false; }
  function isUrl(v){ try{ const u=new URL(v); return /^https?:$/.test(u.protocol);}catch{return false;} }
  function esc(s){ return (s||"").replace(/[&<>]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
  // render a "中文\nEnglish" string: Chinese on top, English (muted) below.
  function bi(s){
    const t=(s||"").trim();
    if(!t) return "";
    const parts=t.split(/\n+/);
    if(parts.length>=2){
      const zh=parts[0].trim();
      const en=parts.slice(1).join(" ").trim();
      return '<span class="bi-zh">'+esc(zh)+'</span><span class="bi-en">'+esc(en)+'</span>';
    }
    return esc(t);
  }

  function startProgress(el, title){
    el.classList.remove("hidden");
    el.innerHTML = '<div class="prog-head"><div class="spinner"></div><div class="prog-title">'+esc(title)+'</div></div><ul class="prog-steps"></ul>';
    return $(".prog-steps", el);
  }
  function addStep(ul, msg){
    $$("li", ul).forEach(li=>li.classList.remove("cur"));
    const li = document.createElement("li");
    li.className="cur"; li.innerHTML='<span class="dot"></span>'+esc(msg);
    ul.appendChild(li);
  }

  // ---- SSE POST stream ----
  async function stream(path, body, onStep, onDone, onErr){
    const res = await fetch(path, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf="";
    for(;;){
      const {value, done} = await reader.read();
      if(done) break;
      buf += dec.decode(value,{stream:true});
      const chunks = buf.split("\n\n"); buf = chunks.pop();
      for(const ch of chunks){
        const ev = (ch.match(/^event: (.*)$/m)||[])[1];
        const dataLine = (ch.match(/^data: (.*)$/m)||[])[1];
        if(!dataLine) continue;
        const data = JSON.parse(dataLine);
        if(ev==="step") onStep(data.msg);
        else if(ev==="done") onDone(data);
        else if(ev==="error") onErr(data.msg);
      }
    }
  }

  // ---- renderers ----
  function paletteHtml(pal){
    return '<div class="palette">'+pal.slice(0,8).map(p=>{
      const c = typeof p==="string"?p:p.color;
      return '<div class="pal"><span class="sw" style="background:'+esc(c)+'"></span><code>'+esc(c)+'</code></div>';
    }).join("")+'</div>';
  }
  function reportCard(x, r){
    const tokens = x.tokens||{};
    const pal = tokens.palette||[];
    return '<div class="r-card">'
      + '<div class="r-head"><div><div class="r-title">'+esc(x.title||x.finalUrl)+'</div><div class="r-url">'+esc(x.finalUrl)+'</div></div>'
      + '<div class="score-ring"><span class="score-num">'+(r.score?.overall ?? "–")+'</span><span class="score-lbl">/10 AESTHETIC</span></div></div>'
      + '<div class="chips">'+(r.vibe||[]).map(v=>'<span class="chip">'+esc(v)+'</span>').join("")+'</div>'
      + '<p class="r-summary">'+bi(r.summary)+'</p>'
      + '<div class="r-section"><h4>配色 · Color</h4><p>'+bi(r.colorAnalysis)+'</p>'+paletteHtml(pal)+'</div>'
      + '<div class="r-section"><h4>字体排版 · Typography</h4><p>'+bi(r.typographyAnalysis)+'</p></div>'
      + '<div class="r-section"><h4>布局 · Layout</h4><p>'+bi(r.layoutAnalysis)+'</p></div>'
      + '<div class="r-section"><h4>动效 · Motion</h4><p>'+bi(r.motionAnalysis)+'</p></div>'
      + '<div class="r-section"><h4>设计建议 · Recommendations</h4><ul class="reco">'+(r.recommendations||[]).map(x=>'<li>'+bi(x)+'</li>').join("")+'</ul></div>'
      + promptBox("同款提示词 · Same-style prompt（可直接复制给任意 AI 参考）", r.sameStylePrompt)
      + '</div>';
  }
  function fusionCard(d){
    const r = d.report;
    return '<div class="r-card">'
      + '<div class="r-head"><div><div class="r-title">融合：'+esc((d.siteA&&d.siteA.title)||"A")+' × '+esc((d.siteB&&d.siteB.title)||"B")+'</div>'
      + '<div class="r-url">权重 A '+d.weightA+'% · B '+(100-d.weightA)+'%</div></div>'
      + '<div class="score-ring"><span class="score-num">'+(r.score?.overall ?? "–")+'</span><span class="score-lbl">/10 AESTHETIC</span></div></div>'
      + '<div class="chips">'+(r.vibe||[]).map(v=>'<span class="chip">'+esc(v)+'</span>').join("")+'</div>'
      + '<p class="r-summary">'+bi(r.summary)+'</p>'
      + '<div class="r-section"><h4>融合配色 · Fused color</h4>'+paletteHtml((d.blend&&d.blend.palette)||[])+'</div>'
      + '<div class="r-section"><h4>设计建议 · Recommendations</h4><ul class="reco">'+(r.recommendations||[]).map(x=>'<li>'+bi(x)+'</li>').join("")+'</ul></div>'
      + promptBox("融合同款提示词 · Fused prompt", r.sameStylePrompt)
      + '</div>';
  }
  function promptBox(title, text){
    return '<div class="prompt-box"><div class="pb-title">'+esc(title)+'</div><div class="pb-body"><button class="copy-btn" type="button">复制</button>'+esc(text||"")+'</div></div>';
  }
  function doneBanner(projectDir){
    if(!projectDir) return "";
    var pd = esc(projectDir);
    return '<div class="r-card" data-project="'+pd+'"><div class="done-banner"><span class="ic">✓</span><div><div style="font-weight:600">同款项目已生成</div><div class="path">'+pd+'</div></div></div>'
      + '<div class="preview-actions">'
      +   '<button class="btn-primary act-preview" type="button">▶ 预览网站</button>'
      +   '<button class="btn-ghost act-export" type="button">💾 导出可双击 HTML</button>'
      + '</div>'
      + '<div class="preview-status hidden"></div>'
      + '<div class="run-cmd">或手动：进入目录后运行 <code>npm install</code> 然后 <code>npm run dev</code></div></div>';
  }
  function bindPreview(root){
    $$(".r-card[data-project]", root).forEach(function(card){
      var dir = card.getAttribute("data-project");
      var status = card.querySelector(".preview-status");
      var setStatus = function(msg, kind){ status.classList.remove("hidden"); status.className = "preview-status" + (kind?" "+kind:""); status.innerHTML = msg; };
      var pv = card.querySelector(".act-preview");
      var ex = card.querySelector(".act-export");
      if(pv) pv.onclick = function(){
        pv.disabled = true; setStatus("正在准备预览（首次会装依赖，请耐心等）…");
        stream("/api/preview", {projectDir: dir},
          function(m){ setStatus("⏳ "+esc(m)); },
          function(d){ pv.disabled=false; if(d&&d.url){ setStatus('✓ 预览已启动：<a href="'+d.url+'" target="_blank">'+d.url+'</a>', "ok"); try{ window.open(d.url, "_blank"); }catch(e){} } else { setStatus("预览已启动。", "ok"); } },
          function(e){ pv.disabled=false; setStatus("出错："+esc(e), "err"); }
        ).catch(function(e){ pv.disabled=false; setStatus("出错："+esc(e.message), "err"); });
      };
      if(ex) ex.onclick = function(){
        ex.disabled = true; setStatus("正在导出静态 HTML…");
        stream("/api/export-html", {projectDir: dir},
          function(m){ setStatus("⏳ "+esc(m)); },
          function(d){ ex.disabled=false; setStatus('✓ 已导出：<span class="path">'+esc(d.file||"")+'</span>（双击该文件即可打开）', "ok"); },
          function(e){ ex.disabled=false; setStatus("出错："+esc(e), "err"); }
        ).catch(function(e){ ex.disabled=false; setStatus("出错："+esc(e.message), "err"); });
      };
    });
  }
  function bindCopy(root){
    $$(".copy-btn", root).forEach(b=> b.onclick = () => {
      const box = b.parentElement;
      navigator.clipboard.writeText(box.textContent.replace(/^复制/, "").trim());
      b.textContent="已复制"; b.classList.add("ok");
      setTimeout(()=>{ b.textContent="复制"; b.classList.remove("ok"); }, 1600);
    });
  }
  function showErr(el, msg){ el.innerHTML = '<div class="err-banner">出错了：'+esc(msg)+'</div>'; }

  // ---- ANALYZE ----
  $("#analyzeRun").onclick = () => {
    if(needKey()) return;
    const url = $("#analyzeUrl").value.trim();
    if(!isUrl(url)){ $("#analyzeUrl").focus(); return; }
    const btn=$("#analyzeRun"); btn.disabled=true;
    const ul = startProgress($("#analyzeProgress"),"正在分析 "+url);
    $("#analyzeResult").innerHTML="";
    stream("/api/analyze", {url, ...cfg},
      m=>addStep(ul,m),
      d=>{ $("#analyzeProgress").classList.add("hidden"); $("#analyzeResult").innerHTML=reportCard(d.extraction,d.report); bindCopy($("#analyzeResult")); btn.disabled=false; },
      e=>{ $("#analyzeProgress").classList.add("hidden"); showErr($("#analyzeResult"),e); btn.disabled=false; }
    ).catch(e=>{ showErr($("#analyzeResult"),e.message); btn.disabled=false; });
  };

  // ---- CLONE ----
  $("#cloneRun").onclick = () => {
    if(needKey()) return;
    const url = $("#cloneUrl").value.trim();
    if(!isUrl(url)){ $("#cloneUrl").focus(); return; }
    const instructions = $("#cloneInstr").value.trim();
    const btn=$("#cloneRun"); btn.disabled=true;
    const ul = startProgress($("#cloneProgress"),"正在分析并生成同款");
    $("#cloneResult").innerHTML="";
    stream("/api/clone", {url, instructions, ...cfg},
      m=>addStep(ul,m),
      d=>{ $("#cloneProgress").classList.add("hidden"); $("#cloneResult").innerHTML=reportCard(d.extraction,d.report)+doneBanner(d.projectDir); bindCopy($("#cloneResult")); bindPreview($("#cloneResult")); btn.disabled=false; },
      e=>{ $("#cloneProgress").classList.add("hidden"); showErr($("#cloneResult"),e); btn.disabled=false; }
    ).catch(e=>{ showErr($("#cloneResult"),e.message); btn.disabled=false; });
  };

  // ---- FUSE weight slider ----
  const weight = $("#weight");
  function syncWeight(){
    const v=+weight.value;
    weight.style.setProperty("--p", v+"%");
    $("#weightTagA").textContent="A "+v+"%";
    $("#weightTagB").textContent="B "+(100-v)+"%";
  }
  weight.oninput = syncWeight; syncWeight();

  $("#previewBtn").onclick = async () => {
    const a=$("#fuseA").value.trim(), b=$("#fuseB").value.trim();
    if(!isUrl(a)||!isUrl(b)){ return; }
    const sw=$("#bpSwatches"); sw.innerHTML='<span class="bp-empty">正在抓取两个网站的配色…</span>';
    try{
      const pa = await quickPalette(a), pb = await quickPalette(b);
      const v=+weight.value/100; const na=Math.max(1,Math.round(8*v)); const nb=Math.max(1,8-na);
      const mix=[...pa.slice(0,na),...pb.slice(0,nb)];
      sw.innerHTML = mix.map(c=>'<span class="sw" style="background:'+esc(c)+'"></span>').join("");
    }catch(e){ sw.innerHTML='<span class="bp-empty">抓取失败：'+esc(e.message)+'</span>'; }
  };
  function quickPalette(url){
    return new Promise((resolve,reject)=>{
      stream("/api/extract",{url}, ()=>{}, d=>{
        const pal=(d.extraction.tokens.palette||[]).map(p=>p.color);
        resolve(pal);
      }, e=>reject(new Error(e))).catch(reject);
    });
  }

  // ---- FUSE run ----
  $("#fuseRun").onclick = () => {
    if(needKey()) return;
    const urlA=$("#fuseA").value.trim(), urlB=$("#fuseB").value.trim();
    if(!isUrl(urlA)){ $("#fuseA").focus(); return; }
    if(!isUrl(urlB)){ $("#fuseB").focus(); return; }
    const instructions=$("#fuseInstr").value.trim();
    const btn=$("#fuseRun"); btn.disabled=true;
    const ul=startProgress($("#fuseProgress"),"正在融合并生成");
    $("#fuseResult").innerHTML="";
    stream("/api/fuse", {urlA, urlB, weight:+weight.value, instructions, build:true, ...cfg},
      m=>addStep(ul,m),
      d=>{ $("#fuseProgress").classList.add("hidden"); $("#fuseResult").innerHTML=fusionCard(d)+doneBanner(d.projectDir); bindCopy($("#fuseResult")); bindPreview($("#fuseResult")); btn.disabled=false; },
      e=>{ $("#fuseProgress").classList.add("hidden"); showErr($("#fuseResult"),e); btn.disabled=false; }
    ).catch(e=>{ showErr($("#fuseResult"),e.message); btn.disabled=false; });
  };

  // ================= HTML FORGE =================
  (function(){
    const MAX = 5;
    let mode = "link"; // link | upload | content
    let sources = [];  // {id, url?, html?, name?, weight}
    let uid = 1;

    const elList = $("#htmlSources");
    const note = $("#htmlSrcNote");
    const fileInput = $("#htmlFile");
    const contentWrap = $("#htmlContentWrap");

    function setMode(m){
      mode = m;
      $$("#htmlMode .seg-btn").forEach(b=>b.classList.toggle("active", b.dataset.mode===m));
      contentWrap.classList.toggle("hidden", m!=="content");
      elList.classList.toggle("hidden", m==="content");
      $(".src-add").classList.toggle("hidden", m==="content");
      if(m!=="content" && sources.length===0) addSource();
      render();
    }
    $$("#htmlMode .seg-btn").forEach(b=> b.onclick = ()=> setMode(b.dataset.mode));

    function addSource(src){
      if(sources.length>=MAX){ flashNote("最多 "+MAX+" 个来源"); return; }
      sources.push(Object.assign({id:uid++, weight:1}, src||{}));
      render();
    }
    function removeSource(id){ sources = sources.filter(s=>s.id!==id); render(); }

    function render(){
      note.textContent = sources.length<=1
        ? "添加 1 个来源做分析/同款；添加多个可对比/融合（最多 "+MAX+" 个）。"
        : sources.length+" 个来源 · 对比/融合会用全部，权重可调。";
      elList.innerHTML = sources.map((s,i)=>{
        const w = s.weight||1;
        const label = s.html ? (s.name||"uploaded.html") : "";
        return '<div class="src-item" data-id="'+s.id+'">'
          + '<span class="src-idx">'+(i+1)+'</span>'
          + (s.html
              ? '<span class="src-file">📄 '+esc(label)+'</span>'
              : '<input class="url-input src-url" type="url" placeholder="https://example.com 或某个 .html 链接" value="'+esc(s.url||"")+'">')
          + '<span class="src-w">权重<input class="w-input" type="number" min="1" max="10" value="'+w+'"></span>'
          + '<button class="x-btn" type="button" title="移除">✕</button>'
          + '</div>';
      }).join("");
      $$(".src-item", elList).forEach(it=>{
        const id = +it.dataset.id;
        const s = sources.find(z=>z.id===id);
        const urlInp = $(".src-url", it); if(urlInp) urlInp.oninput = ()=> s.url = urlInp.value.trim();
        const wInp = $(".w-input", it); if(wInp) wInp.oninput = ()=> s.weight = Math.max(1, +wInp.value||1);
        $(".x-btn", it).onclick = ()=> removeSource(id);
      });
    }
    function flashNote(msg){ note.textContent = msg; note.classList.add("warn"); setTimeout(()=>note.classList.remove("warn"), 1500); }

    $("#htmlAddSrc").onclick = ()=>{
      if(mode==="upload"){ fileInput.click(); }
      else { addSource(); }
    };
    fileInput.onchange = async ()=>{
      const files = [...fileInput.files].slice(0, MAX - sources.filter(s=>s.html).length);
      for(const f of files){
        try{ const text = await f.text(); addSource({ html:text, name:f.name }); }catch{}
      }
      fileInput.value="";
    };

    $("#optCreativity").oninput = ()=> $("#creLabel").textContent = (+$("#optCreativity").value).toFixed(1);

    function gatherOpts(){
      return {
        purpose: $("#optPurpose").value,
        language: $("#optLanguage").value,
        tone: $("#optTone").value,
        colorMode: $("#optColor").value,
        density: $("#optDensity").value,
        animation: $("#optAnim").value,
        fontHint: $("#optFont").value.trim(),
        sections: $("#optSections").value.trim(),
        creativity: +$("#optCreativity").value,
        upgrade: $("#optUpgrade").checked,
        instructions: $("#optInstr").value.trim(),
      };
    }
    function firstSourceBody(){
      const s = sources[0];
      if(!s) return null;
      if(s.html) return { html:s.html, name:s.name };
      if(s.url) return { url:s.url };
      return null;
    }
    function allSourcesBody(){
      return sources.map(s=> s.html ? { html:s.html, name:s.name, weight:s.weight } : { url:s.url, weight:s.weight }).filter(s=> s.html || s.url);
    }

    function htmlDoneCard(d){
      let h = "";
      if(d.report) h += d.report.upgradeIdeas ? htmlReportCard(d.report) : compareCard(d.report);
      if(d.plan) h += '<div class="prompt-box"><div class="pb-title">融合方案 Fusion plan</div><div class="pb-body">'+esc(d.plan)+'</div></div>';
      if(d.file) h += '<div class="r-card"><div class="done-banner"><span class="ic">✓</span><div><div style="font-weight:600">已生成单文件 HTML</div><div class="path">'+esc(d.file)+'</div></div></div>'
        + '<div class="run-cmd">双击该 .html 即可在浏览器查看。下方可预览/下载。</div>'
        + (d.html ? '<div class="html-actions"><button class="ghost-btn" id="htmlPreviewBtn" type="button">预览</button><button class="ghost-btn" id="htmlDownloadBtn" type="button">下载 .html</button></div><iframe class="html-frame hidden" id="htmlFrame"></iframe>' : '')
        + '</div>';
      return h;
    }
    function htmlReportCard(r){
      return '<div class="r-card">'
        + '<div class="chips">'+(r.vibe||[]).map(v=>'<span class="chip">'+esc(v)+'</span>').join("")+'</div>'
        + '<p class="r-summary">'+bi(r.summary)+'</p>'
        + '<div class="r-section"><h4>配色 · Color</h4><p>'+bi(r.colorAnalysis)+'</p></div>'
        + '<div class="r-section"><h4>字体排版 · Typography</h4><p>'+bi(r.typographyAnalysis)+'</p></div>'
        + '<div class="r-section"><h4>布局 · Layout</h4><p>'+bi(r.layoutAnalysis)+'</p></div>'
        + '<div class="r-section"><h4>结构 · Structure</h4><p>'+bi(r.structureAnalysis)+'</p></div>'
        + '<div class="r-section"><h4>设计建议 · Recommendations</h4><ul class="reco">'+(r.recommendations||[]).map(x=>'<li>'+bi(x)+'</li>').join("")+'</ul></div>'
        + '<div class="r-section"><h4>升级思路 · Upgrade ideas</h4><ul class="reco">'+(r.upgradeIdeas||[]).map(x=>'<li>'+bi(x)+'</li>').join("")+'</ul></div>'
        + promptBox("同款提示词 · Same-style prompt", r.sameStylePrompt)
        + '</div>';
    }
    function compareCard(r){
      return '<div class="r-card">'
        + '<p class="r-summary">'+bi(r.summary)+'</p>'
        + '<div class="r-section"><h4>逐个点评 · Per source</h4><ul class="reco">'+(r.perSource||[]).map(p=>'<li><b>'+esc(p.title)+'</b><br>'+bi(p.strengths)+'<br>'+bi(p.weaknesses)+'</li>').join("")+'</ul></div>'
        + '<div class="r-section"><h4>差异 · Contrasts</h4><p>'+bi(r.contrasts)+'</p></div>'
        + '<div class="r-section"><h4>融合建议 · Fusion advice</h4><p>'+bi(r.fusionAdvice)+'</p></div>'
        + promptBox("融合提示词 · Fusion prompt", r.sameStylePrompt)
        + '</div>';
    }
    function bindHtmlResult(root, html){
      bindCopy(root);
      const pv = $("#htmlPreviewBtn", root), dl = $("#htmlDownloadBtn", root), fr = $("#htmlFrame", root);
      if(pv && fr) pv.onclick = ()=>{ fr.classList.toggle("hidden"); if(!fr.classList.contains("hidden")) fr.srcdoc = html; };
      if(dl) dl.onclick = ()=>{ const b=new Blob([html],{type:"text/html"}); const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download="designforge.html"; a.click(); };
    }

    function runHtml(path, body, title){
      if(needKey()) return;
      const btns = $$(".actions.wrap .run-btn"); btns.forEach(b=>b.disabled=true);
      const ul = startProgress($("#htmlProgress"), title);
      $("#htmlResult").innerHTML="";
      stream(path, Object.assign({}, body, cfg),
        m=>addStep(ul,m),
        d=>{ $("#htmlProgress").classList.add("hidden"); $("#htmlResult").innerHTML=htmlDoneCard(d); bindHtmlResult($("#htmlResult"), d.html||""); btns.forEach(b=>b.disabled=false); },
        e=>{ $("#htmlProgress").classList.add("hidden"); showErr($("#htmlResult"),e); btns.forEach(b=>b.disabled=false); }
      ).catch(e=>{ showErr($("#htmlResult"),e.message); btns.forEach(b=>b.disabled=false); });
    }

    $("#htmlAnalyzeRun").onclick = ()=>{
      const src = firstSourceBody(); if(!src){ flashNote("请先添加一个链接或文件"); return; }
      runHtml("/api/html-analyze", Object.assign(src, gatherOpts()), "正在分析 HTML");
    };
    $("#htmlCloneRun").onclick = ()=>{
      const src = firstSourceBody(); if(!src){ flashNote("请先添加一个链接或文件"); return; }
      runHtml("/api/html-clone", Object.assign(src, gatherOpts()), "正在生成升级版同款 HTML");
    };
    $("#htmlComposeRun").onclick = ()=>{
      const content = $("#htmlContent").value.trim();
      if(!content){ setMode("content"); flashNote && 0; $("#htmlContent").focus(); return; }
      runHtml("/api/html-compose", Object.assign({ content }, gatherOpts()), "正在用你的内容生成 HTML");
    };
    $("#htmlCompareRun").onclick = ()=>{
      const arr = allSourcesBody(); if(arr.length<2){ flashNote("对比需要至少 2 个来源"); return; }
      runHtml("/api/html-compare", Object.assign({ sources:arr }, gatherOpts()), "正在对比多个 HTML");
    };
    $("#htmlFuseRun").onclick = ()=>{
      const arr = allSourcesBody(); if(arr.length<2){ flashNote("融合需要至少 2 个来源"); return; }
      runHtml("/api/html-fuse", Object.assign({ sources:arr }, gatherOpts()), "正在融合多个 HTML");
    };

    // init
    setMode("link");
  })();

})();
