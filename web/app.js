/* 帧鉴 · 主控 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const fmtTC = window.fmtTC;

  const S = {
    cid: null, proj: null, ana: null, sel: -1,
    playTimer: null, saveTimer: null, pollTimer: null, lastOpenDir: ''
  };

  let tl = null;
  let BOOT_Q = null;

  // ------------------------------------------------------------- api
  async function api(path, opt) {
    const r = await fetch(path, opt);
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('返回不是 JSON'); }
    if (!j.ok) throw new Error(j.error || '请求失败');
    return j;
  }
  const setStatus = (txt, cls) => {
    const s = $('#status'); s.textContent = txt; s.className = 'status' + (cls ? ' ' + cls : '');
  };

  // ------------------------------------------------------------- 导入
  const VID_RE = /\.(mp4|m4v|mov|mkv|avi|webm|wmv|flv|ts|mpg|mpeg)$/i;

  function uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
      xhr.upload.onprogress = e => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        try {
          const j = JSON.parse(xhr.responseText);
          if (j.ok) resolve(j); else reject(new Error(j.error || '上传失败'));
        } catch (err) { reject(new Error('上传响应异常')); }
      };
      xhr.onerror = () => reject(new Error('上传中断'));
      xhr.send(file);
    });
  }

  async function importFile(file) {
    if (!VID_RE.test(file.name)) { setStatus('不支持的格式：' + file.name, 'err'); return; }
    setStatus('上传中 0%', 'busy');
    try {
      const j = await uploadFile(file, p => setStatus('上传中 ' + Math.round(p * 100) + '%', 'busy'));
      setStatus('读取元信息…', 'busy');
      await openVideo(j.path);
    } catch (e) { setStatus(e.message, 'err'); }
  }

  async function loadRecent() {
    const box = $('#recent');
    if (!box) return;
    try {
      const j = await api('/api/projects');
      box.innerHTML = '';
      if (!j.items.length) return;
      const lb = el('div', 'rlabel', '最近打开');
      box.appendChild(lb);
      j.items.slice(0, 6).forEach(it => {
        const b = el('button', null, (it.title || '未命名') + ' <i>' + (it.shots || 0) + ' 镜</i>');
        b.title = it.video;
        b.onclick = ev => { ev.stopPropagation(); loadById(it.id); };
        box.appendChild(b);
      });
    } catch (e) { /* 忽略 */ }
  }

  /* 把当前项目写进地址栏 + localStorage，刷新后自动回来 */
  function rememberOpen(cid) {
    try { localStorage.setItem('cinegraph.last', cid); } catch (e) { /* ignore */ }
    try {
      const u = new URL(location.href);
      u.searchParams.set('open', cid);
      u.searchParams.delete('t');
      u.searchParams.delete('z');
      history.replaceState(null, '', u.pathname + u.search);
    } catch (e) { /* ignore */ }
  }
  function lastOpen() {
    try { return localStorage.getItem('cinegraph.last'); } catch (e) { return null; }
  }

  function bindDrop() {
    const dz = $('#dropzone');
    let depth = 0;
    ['dragenter'].forEach(ev => document.addEventListener(ev, e => {
      e.preventDefault();
      depth++;
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dz.classList.add('drag');
    }));
    document.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', e => {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) dz.classList.remove('drag');
    });
    document.addEventListener('drop', e => {
      e.preventDefault();
      depth = 0;
      dz.classList.remove('drag');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importFile(f);
    });
  }

  // ------------------------------------------------------------- 打开影片
  let picking = false;

  /* 走浏览器的 <input type=file>：对话框由浏览器进程弹出，
     任务栏不会多出窗口图标。选中后流式上传到本地服务再分析。 */
  function pickViaInput() {
    if (picking) return;
    const inp = $('#fileInput');
    inp.value = '';
    inp.click();
  }

  function bindFileInput() {
    const inp = $('#fileInput');
    if (!inp) return;
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      if (f) importFile(f);
    });
  }

  function modal(title, bodyHTML, footHTML) {
    const d = $('#dialog');
    d.innerHTML = '';
    const h = el('h3', null, title);
    const close = el('button', null, '关闭');
    close.onclick = closeModal;
    h.appendChild(close);
    d.appendChild(h);
    const b = el('div', 'body'); b.innerHTML = bodyHTML; d.appendChild(b);
    if (footHTML) { const f = el('div', 'foot'); f.innerHTML = footHTML; d.appendChild(f); }
    $('#mask').classList.add('show');
    return d;
  }
  function closeModal() { $('#mask').classList.remove('show'); }

  async function openPicker(startPath) {
    const d = modal('打开影片', `
      <div class="pathbar">
        <input id="pth" placeholder="输入文件夹路径，或从下面选择" value="">
        <button id="go">前往</button>
      </div>
      <div class="flist" id="flist">载入中…</div>
    `, `<button class="on" id="okPick">打开选中的影片</button>`);

    const list = d.querySelector('#flist');
    const pth = d.querySelector('#pth');

    async function load(path) {
      list.innerHTML = '载入中…';
      try {
        const j = await api('/api/browse?path=' + encodeURIComponent(path || ''));
        pth.value = j.path || '';
        list.innerHTML = '';
        if (j.up) {
          const up = el('div', 'fitem', '<span class="ico">↑</span><span>上一级</span>');
          up.onclick = () => load(j.up);
          list.appendChild(up);
        }
        const base = j.path || '';
        const sep = (base === '' || /[\\/]$/.test(base)) ? '' : '\\';
        j.dirs.forEach(name => {
          const it = el('div', 'fitem', '<span class="ico">📁</span><span>' + name + '</span>');
          it.onclick = () => load(base + sep + name);
          list.appendChild(it);
        });
        j.files.forEach(f => {
          const full = base + sep + f.name;
          const it = el('div', 'fitem vid',
            '<span class="ico">🎬</span><span>' + f.name + '</span>' +
            '<span class="sz">' + (f.size / 1048576).toFixed(1) + ' MB</span>');
          it.onclick = () => {
            list.querySelectorAll('.fitem').forEach(x => x.style.background = '');
            it.style.background = '#2a2415';
            d.dataset.pick = full;
          };
          it.ondblclick = () => {
            d.dataset.pick = full;
            d.querySelector('#okPick').click();
          };
          list.appendChild(it);
        });
        if (!j.dirs.length && !j.files.length) list.innerHTML = '<div class="fitem">（空文件夹）</div>';
      } catch (e) {
        list.innerHTML = '<div class="fitem" style="color:#ff5c5c">' + e.message + '</div>';
      }
    }

    d.querySelector('#go').onclick = () => load(pth.value.trim());
    pth.onkeydown = e => { if (e.key === 'Enter') load(pth.value.trim()); };
    d.querySelector('#okPick').onclick = () => {
      if (!d.dataset.pick) { alert('先在列表里点选一个视频文件'); return; }
      closeModal();
      openVideo(d.dataset.pick);
    };
    load(startPath || S.lastOpenDir || '');
  }

  async function openVideo(path) {
    setStatus('打开中…', 'busy');
    try {
      const j = await api('/api/open?path=' + encodeURIComponent(path));
      S.cid = j.id; S.proj = j.project; S.sel = -1; S.ana = null;
      S.lastOpenDir = path.replace(/[\\/][^\\/]+$/, '');
      $('#projTitle').textContent = S.proj.title || path;
      document.title = (S.proj.title || '帧鉴') + ' · 帧鉴';
      rememberOpen(j.id);

      const v = $('#video');
      v.src = '/media?id=' + S.cid + '&t=' + Date.now();
      v.load();
      $('#hud').textContent = path;
      $('#dropzone').classList.add('hide');

      if (tl) tl.setData({ duration: S.proj.meta.duration, shots: [], sections: S.proj.sections, strip: null, wave: null, metrics: null });
      renderShots();
      clearEditor();

      if (j.analyzing) { setStatus('分析中…', 'busy'); startPoll(); }
      else { await loadAnalysis(); }
    } catch (e) {
      setStatus(e.message, 'err');
    }
  }

  function startPoll() {
    clearTimeout(S.pollTimer);
    const tick = async () => {
      try {
        const j = await api('/api/status?id=' + S.cid);
        const p = j.progress || {};
        const msg = p.msg || p.stage || '分析中';
        const pct = Math.round((p.pct || 0) * 100);
        setStatus(msg.indexOf('%') >= 0 ? msg : msg + '  ' + pct + '%', 'busy');
        if (p.stage === 'error') { setStatus('分析失败：' + (p.msg || ''), 'err'); return; }
        if (j.ready) { await loadAnalysis(); return; }
        S.pollTimer = setTimeout(tick, 400);
      } catch (e) { setStatus(e.message, 'err'); }
    };
    tick();
  }

  async function loadAnalysis() {
    try {
      const j = await api('/api/analysis?id=' + S.cid);
      S.ana = { meta: j.meta, shots: j.shots, strip: j.strip, wave: j.wave, metrics: j.metrics };
      if (!S.proj.meta || !S.proj.meta.duration) S.proj.meta = j.meta;
      if (!S.proj.shots || !S.proj.shots.length) S.proj.shots = j.shots.map(s => Object.assign({}, s));
      S.proj.meta = j.meta;

      tl.opts.cid = S.cid;
      tl.setData({
        duration: j.meta.duration, shots: S.proj.shots,
        sections: S.proj.sections, strip: j.strip, wave: j.wave, metrics: j.metrics
      });
      tl.fit();
      renderShots();
      setStatus('就绪 · ' + j.shots.length + ' 镜 · ' + fmtDur(j.meta.duration), '');
      applyViewParams();
    } catch (e) { setStatus(e.message, 'err'); }
  }

  function applyViewParams() {
    const q = BOOT_Q || new URLSearchParams(location.search);
    const zs = q.get('z'), ts = q.get('t');
    if (!zs) return;
    const z = parseFloat(zs);
    if (!(z > 0)) return;
    tl.viewDur = clamp(z, 0.5, Math.max(1, tl.duration));
    const t = ts ? parseFloat(ts) : 0;
    tl.viewT0 = clamp(t - tl.viewDur * 0.5, 0, Math.max(0, tl.duration - tl.viewDur));
    if (ts) seekTo(t);
    tl.draw();
  }

  const fmtDur = t => {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + '分' + String(s).padStart(2, '0') + '秒';
  };

  // ------------------------------------------------------------- 列表
  function renderShots() {
    const box = $('#shotList');
    box.innerHTML = '';
    const q = ($('#filter').value || '').trim().toLowerCase();
    const shots = S.proj ? S.proj.shots : [];
    let n = 0;
    shots.forEach((s, i) => {
      const label = [s.scale, s.move].filter(Boolean).join(' · ');
      const text = [s.content, s.note, s.func, s.sound].filter(Boolean).join(' ');
      if (q && !(label + ' ' + text + ' ' + i).toLowerCase().includes(q)) return;
      n++;
      const row = el('div', 'srow' + (i === S.sel ? ' sel' : ''));
      row.innerHTML =
        '<span class="no">' + String(i + 1).padStart(3, '0') + '</span>' +
        '<span class="dur">' + s.dur.toFixed(2) + 's</span>' +
        '<span class="lbl">' + (label ? '<b>' + esc(label) + '</b>' : '<i>未标注</i>') +
        (s.content ? '<i>' + esc(s.content.slice(0, 28)) + '</i>' : '') + '</span>';
      row.onclick = () => selectShot(i, true);
      row.dataset.t = s.t;
      box.appendChild(row);
    });
    $('#shotCount').textContent = n + '/' + shots.length;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function selectShot(i, seek) {
    S.sel = i;
    tl.setSelected(i);
    renderShots();
    renderEditor();
    const s = S.proj.shots[i];
    if (seek && s) { seekTo(s.t + 0.02); tl.scrollTo(s.t); }
    const rows = $('#shotList').children;
    const q = ($('#filter').value || '').trim();
    const target = rows[Array.from(rows).findIndex(r => r.classList.contains('sel'))];
    if (target) target.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------- 编辑器
  const FUNCS = ['建立', '铺垫', '激励事件', '递进', '转折', '高潮', '释放', '过渡', '收束'];

  function clearEditor() {
    $('#editor').innerHTML = '<div class="empty">点击时间线上的镜头块，或按 <kbd>S</kbd> 在当前帧新建镜头</div>';
  }

  function renderEditor() {
    const box = $('#editor');
    if (S.sel < 0 || !S.proj || !S.proj.shots[S.sel]) { clearEditor(); return; }
    const s = S.proj.shots[S.sel];
    const tags = S.proj.tags || {};
    const end = s.t + s.dur;

    box.innerHTML = `
      <h4>镜头 ${String(S.sel + 1).padStart(3, '0')}
        <span>${fmtTC(s.t, true)} → ${fmtTC(end, true)} · ${s.dur.toFixed(2)}s</span></h4>
      <div class="field"><label>入点</label><input class="f-t" type="text" value="${fmtTC(s.t, true)}"></div>
      <div class="field"><label>时长</label><input class="f-d" type="number" step="0.01" value="${s.dur.toFixed(2)}"></div>
      <div class="field"><label>景别</label><div class="chips f-scale">${(tags.scale || []).map(t => `<button data-v="${t}" class="${s.scale === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>运动</label><div class="chips f-move">${(tags.move || []).map(t => `<button data-v="${t}" class="${s.move === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>光线</label><div class="chips f-light">${(tags.light || []).map(t => `<button data-v="${t}" class="${s.light === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>色彩</label><div class="chips f-color">${(tags.color || []).map(t => `<button data-v="${t}" class="${s.color === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>功能</label>
        <select class="f-func"><option value="">—</option>${FUNCS.map(f => `<option ${s.func === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      <div class="field"><label>画面</label><textarea class="f-content" placeholder="谁 在 哪里 做什么">${esc(s.content || '')}</textarea></div>
      <div class="field"><label>声音</label><input class="f-sound" type="text" value="${esc(s.sound || '')}" placeholder="台词 / 音乐 / 音效 / 静默"></div>
      <div class="field"><label>备注</label><textarea class="f-note" placeholder="判断、联想、可复用手法">${esc(s.note || '')}</textarea></div>
      <div class="row2">
        <button class="j-prev">◀ 上一镜</button>
        <button class="j-play">播放本镜</button>
        <button class="j-next">下一镜 ▶</button>
      </div>
      <div class="row2">
        <button class="j-split">在播放头处切开</button>
        <button class="j-del">删除并合并到前一镜</button>
      </div>
    `;

    const commit = () => { markDirty(); scheduleSave(); };

    box.querySelectorAll('.chips button').forEach(b => {
      b.onclick = () => {
        const wrap = b.parentElement;
        const key = { 'f-scale': 'scale', 'f-move': 'move', 'f-light': 'light', 'f-color': 'color' }[wrap.className.split(' ')[1]];
        const v = b.dataset.v;
        s[key] = (s[key] === v) ? '' : v;
        wrap.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === s[key]));
        commit(); renderShots(); tl.draw();
      };
    });
    box.querySelector('.f-func').onchange = e => { s.func = e.target.value; commit(); renderShots(); tl.draw(); };
    box.querySelector('.f-content').oninput = e => { s.content = e.target.value; commit(); renderShots(); };
    box.querySelector('.f-sound').oninput = e => { s.sound = e.target.value; commit(); };
    box.querySelector('.f-note').oninput = e => { s.note = e.target.value; commit(); };
    box.querySelector('.f-t').onchange = e => {
      const t = parseTC(e.target.value);
      if (t == null) return;
      s.t = clamp(t, 0, S.proj.meta.duration - 0.05);
      s.dur = Math.max(0.03, Math.min(s.dur, S.proj.meta.duration - s.t));
      commit(); renderEditor(); tl.draw(); renderShots();
    };
    box.querySelector('.f-d').onchange = e => {
      const d = parseFloat(e.target.value);
      if (!isFinite(d) || d <= 0) return;
      s.dur = Math.min(d, S.proj.meta.duration - s.t);
      commit(); renderEditor(); tl.draw(); renderShots();
    };
    box.querySelector('.j-prev').onclick = () => { if (S.sel > 0) selectShot(S.sel - 1, true); };
    box.querySelector('.j-next').onclick = () => { if (S.sel < S.proj.shots.length - 1) selectShot(S.sel + 1, true); };
    box.querySelector('.j-play').onclick = () => {
      const v = $('#video');
      seekTo(s.t + 0.02);
      v.play(); S.stopAt = end - 0.02;
    };
    box.querySelector('.j-split').onclick = () => splitAt(videoTime());
    box.querySelector('.j-del').onclick = () => deleteShot(S.sel);
  }

  function parseTC(str) {
    const m = String(str).trim().match(/^(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?$/);
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +('0.' + m[4]) : 0);
  }

  function markDirty() { S.dirty = true; }
  function scheduleSave() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => save(false), 900);
  }
  async function save(verbose) {
    if (!S.cid || !S.proj) return;
    try {
      await api('/api/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: S.cid, project: { title: S.proj.title, shots: S.proj.shots, sections: S.proj.sections, tags: S.proj.tags } })
      });
      S.dirty = false;
      if (verbose) setStatus('已保存 ' + new Date().toLocaleTimeString(), '');
    } catch (e) { if (verbose) setStatus('保存失败：' + e.message, 'err'); }
  }

  // ------------------------------------------------------------- 播放
  const video = $('#video');
  const videoTime = () => video.currentTime || 0;

  function seekTo(t) {
    if (!S.proj) return;
    video.currentTime = clamp(t, 0, S.proj.meta.duration);
    tl.setPlayhead(video.currentTime);
    updateTC();
  }
  function updateTC() {
    $('#tc').textContent = fmtTC(videoTime(), true);
    const s = shotAt(videoTime());
    $('#shotInfo').textContent = s ? ('镜 ' + String(S.proj.shots.indexOf(s) + 1).padStart(3, '0') + ' / ' + s.dur.toFixed(2) + 's') : '';
  }
  function shotAt(t) {
    if (!S.proj) return null;
    return S.proj.shots.find(s => t >= s.t && t < s.t + s.dur) || null;
  }

  video.addEventListener('timeupdate', () => {
    tl.setPlayhead(video.currentTime);
    tl.scrollTo(video.currentTime);
    updateTC();
    if (S.stopAt != null && video.currentTime >= S.stopAt) { video.pause(); S.stopAt = null; }
    if (!posTimer) posTimer = setTimeout(() => { posTimer = null; savePos(); }, 2000);
  });
  video.addEventListener('play', () => { $('#btnPlay').textContent = '⏸'; });
  video.addEventListener('pause', () => { $('#btnPlay').textContent = '▶'; });
  video.addEventListener('loadedmetadata', () => { updateTC(); });
  video.addEventListener('error', () => { setStatus('视频无法播放（编码不受支持？）', 'err'); });

  $('#btnPlay').onclick = () => { if (video.paused) video.play(); else video.pause(); };
  $('#btnFrameBack').onclick = () => step(-1);
  $('#btnFrameFwd').onclick = () => step(1);
  $('#btnPrevShot').onclick = () => { video.pause(); const i = S.sel > 0 ? S.sel - 1 : 0; selectShot(i, true); };
  $('#btnNextShot').onclick = () => { video.pause(); const i = S.sel < S.proj.shots.length - 1 ? S.sel + 1 : S.sel; selectShot(i, true); };
  $('#speed').onchange = e => { video.playbackRate = parseFloat(e.target.value); };
  $('#vol').oninput = e => { video.volume = parseFloat(e.target.value); };

  function step(dir) {
    if (!S.proj) return;
    video.pause();
    const fps = (S.proj.meta && S.proj.meta.fps) || 25;
    seekTo(videoTime() + dir / fps);
  }

  // ------------------------------------------------------------- 镜头编辑
  function splitAt(t) {
    const shots = S.proj.shots;
    const i = shots.findIndex(s => t > s.t + 0.05 && t < s.t + s.dur - 0.05);
    if (i < 0) { setStatus('播放头不在任一镜头内部，无法切开', 'err'); return; }
    const s = shots[i];
    const a = Object.assign({}, s, { dur: +(t - s.t).toFixed(3) });
    const b = Object.assign({}, s, { t: +t.toFixed(3), dur: +(s.t + s.dur - t).toFixed(3) });
    b.scale = b.move = b.light = b.color = b.func = b.content = b.sound = b.note = '';
    shots.splice(i, 1, a, b);
    reindex(); markDirty(); scheduleSave(); renderShots(); tl.draw(); renderEditor();
  }
  function deleteShot(i) {
    const shots = S.proj.shots;
    if (shots.length <= 1) return;
    const s = shots[i];
    if (i > 0) {
      shots[i - 1].dur = +(shots[i - 1].dur + s.dur).toFixed(3);
    } else {
      shots[1].t = 0; shots[1].dur = +(shots[1].dur + s.dur).toFixed(3);
    }
    shots.splice(i, 1);
    S.sel = Math.max(0, i - 1);
    reindex(); markDirty(); scheduleSave(); renderShots(); tl.draw(); renderEditor();
  }
  function insertShotAt(t) {
    const shots = S.proj.shots;
    const i = shots.findIndex(s => t > s.t + 0.05 && t < s.t + s.dur - 0.05);
    if (i < 0) { setStatus('播放头不在镜头内部', 'err'); return; }
    splitAt(t);
    selectShot(i + 1, false);
  }
  function reindex() { S.proj.shots.forEach((s, i) => s.idx = i + 1); }

  // ------------------------------------------------------------- 镜头列表筛选
  $('#filter').oninput = renderShots;

  // ------------------------------------------------------------- 导出
  function shotFrameDataURL(t, q) {
    const s = S.ana && S.ana.strip;
    if (!s || !s.files) return '';
    const fps = s.fps || 1;
    const fi = Math.floor(t * fps);
    const sheet = Math.floor(fi / s.per);
    const img = tl.images[sheet];
    if (!img || !img.width) return '';
    const cell = fi % s.per;
    const col = cell % s.cols, row = Math.floor(cell / s.cols);
    const cw = s.cell_w, ch = s.cell_h;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(img, col * (cw + 2), row * (ch + 2), cw, ch, 0, 0, cw, ch);
    return c.toDataURL('image/jpeg', q || 0.72);
  }

  function exportDialog() {
    const d = modal('导出拉片结果', `
      <div class="expgrid">
        <button data-fmt="md"><b>Markdown 拉片表</b><span>表格形式，可直接粘进 Notion / Obsidian</span></button>
        <button data-fmt="html"><b>HTML 横向镜头表</b><span>带首帧缩略图，单文件离线可开</span></button>
        <button data-fmt="csv"><b>CSV</b><span>进 Excel / 表格统计</span></button>
        <button data-fmt="json"><b>JSON 项目</b><span>完整数据，可备份或换机器</span></button>
      </div>
    `, '');
    d.querySelectorAll('.expgrid button').forEach(b => {
      b.onclick = () => { closeModal(); doExport(b.dataset.fmt); };
    });
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function doExport(fmt) {
    const p = S.proj;
    const name = (p.title || '拉片').replace(/[\\/:*?"<>|]/g, '_');
    if (fmt === 'json') {
      download(name + '.cinegraph.json', JSON.stringify(p, null, 2), 'application/json');
      return;
    }
    const rows = p.shots.map((s, i) => ({
      no: i + 1, tc: fmtTC(s.t, true), dur: s.dur.toFixed(2),
      scale: s.scale || '', move: s.move || '', light: s.light || '', color: s.color || '',
      content: s.content || '', sound: s.sound || '', func: s.func || '', note: s.note || ''
    }));

    if (fmt === 'csv') {
      const head = ['镜号', '入点', '时长', '景别', '运动', '光线', '色彩', '画面', '声音', '功能', '备注'];
      const lines = [head.join(',')];
      rows.forEach(r => {
        lines.push([r.no, r.tc, r.dur, r.scale, r.move, r.light, r.color, r.content, r.sound, r.func, r.note]
          .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','));
      });
      download(name + '-拉片表.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
      return;
    }

    const meta = p.meta || {};
    const head = `# ${p.title} · 拉片表

- 片源：\`${p.video}\`
- 规格：${meta.width}×${meta.height} · ${meta.fps}fps · ${fmtTC(meta.duration, false)} · ${meta.vcodec || ''}/${meta.acodec || ''}
- 镜头数：${p.shots.length} · 平均时长：${(meta.duration / p.shots.length).toFixed(2)}s
- 导出：${new Date().toLocaleString()}

`;

    if (fmt === 'md') {
      let md = head + '## 镜头表\n\n| # | 入点 | 时长 | 景别 | 运动 | 光线 | 色彩 | 画面 | 声音 | 功能 | 备注 |\n|---|---|---|---|---|---|---|---|---|---|---|\n';
      rows.forEach(r => {
        md += `| ${r.no} | ${r.tc} | ${r.dur}s | ${r.scale} | ${r.move} | ${r.light} | ${r.color} | ${r.content.replace(/\n/g, ' ')} | ${r.sound} | ${r.func} | ${r.note.replace(/\n/g, ' ')} |\n`;
      });
      if (p.sections && p.sections.length) {
        md += '\n## 段落\n\n| # | 起 | 时长 | 标题 | 说明 |\n|---|---|---|---|---|\n';
        p.sections.forEach((s, i) => { md += `| ${i + 1} | ${fmtTC(s.t)} | ${s.dur.toFixed(1)}s | ${s.title || ''} | ${(s.note || '').replace(/\n/g, ' ')} |\n`; });
      }
      download(name + '-拉片表.md', md, 'text/markdown;charset=utf-8');
      return;
    }

    if (fmt === 'html') {
      setStatus('生成 HTML（抽帧中）…', 'busy');
      const cards = p.shots.map((s, i) => {
        const img = shotFrameDataURL(s.t);
        return `<div class="shot">
  <div class="fr">${img ? `<img src="${img}">` : ''}</div>
  <div class="meta">
    <div class="no">${String(i + 1).padStart(3, '0')} <span>${fmtTC(s.t, true)}</span> <em>${s.dur.toFixed(2)}s</em></div>
    <div class="tags">${[s.scale, s.move, s.light, s.color, s.func].filter(Boolean).map(t => `<i>${esc(t)}</i>`).join('')}</div>
    ${s.content ? `<p class="c">${esc(s.content)}</p>` : ''}
    ${s.sound ? `<p class="s">♪ ${esc(s.sound)}</p>` : ''}
    ${s.note ? `<p class="n">${esc(s.note)}</p>` : ''}
  </div>
</div>`;
      }).join('\n');

      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(p.title)} · 拉片表</title>
<style>
:root{--bg:#0e1013;--panel:#15181d;--line:#262c35;--txt:#c8d1dc;--dim:#7b8794;--amber:#ffb340}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:26px 34px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{margin:0 0 10px;font-size:21px;color:#fff}
.meta-line{color:var(--dim);font-size:12px;line-height:1.9}
.meta-line b{color:var(--amber);font-weight:500}
.wrap{padding:22px 34px 60px}
.shot{display:grid;grid-template-columns:184px 1fr;gap:16px;padding:14px 0;border-bottom:1px solid #1a1e24}
.shot:hover{background:#141820}
.fr{background:#000;border-radius:5px;overflow:hidden;line-height:0}
.fr img{width:184px;height:auto;display:block}
.meta .no{font:600 13px ui-monospace,Consolas,monospace;color:var(--amber)}
.meta .no span{color:#8fb6d6;font-weight:400;margin-left:7px}
.meta .no em{color:var(--dim);font-style:normal;margin-left:7px;font-weight:400}
.tags{margin:5px 0 6px;display:flex;flex-wrap:wrap;gap:5px}
.tags i{font-style:normal;font-size:11px;background:#222833;color:#9fb0c2;padding:1px 8px;border-radius:9px}
p{margin:3px 0;font-size:12.5px}
p.c{color:#c2ccd8}
p.s{color:#7fb0d8}
p.n{color:#8d9aa8;font-size:12px;border-left:2px solid #333c47;padding-left:9px;margin-top:6px}
</style></head><body>
<header>
  <h1>${esc(p.title)} · 拉片表</h1>
  <div class="meta-line">
    规格 <b>${meta.width}×${meta.height}</b> · <b>${meta.fps}fps</b> · <b>${fmtTC(meta.duration, false)}</b> · ${meta.vcodec || ''}/${meta.acodec || ''}<br>
    镜头 <b>${p.shots.length}</b> · 平均 <b>${(meta.duration / p.shots.length).toFixed(2)}s</b> · 导出 ${new Date().toLocaleString()}
  </div>
</header>
<div class="wrap">
${cards}
</div>
</body></html>`;
      download(name + '-拉片表.html', html, 'text/html;charset=utf-8');
      setStatus('就绪', '');
    }
  }

  // ------------------------------------------------------------- 工具条
  $('#btnOpen').onclick = () => pickViaInput();
  const dzEl = $('#dropzone');
  dzEl.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    pickViaInput();
  });
  const bp2 = $('#btnPick2');
  if (bp2) bp2.onclick = e => { e.stopPropagation(); pickViaInput(); };
  const bAlt = $('#btnBrowse');
  if (bAlt) bAlt.onclick = e => { e.stopPropagation(); openPicker(S.lastOpenDir || ''); };
  $('#btnSave').onclick = () => save(true);
  $('#btnExport').onclick = () => { if (!S.proj) return; exportDialog(); };
  const bk = $('#btnKeys');
  if (bk) bk.onclick = () => shortcutsDialog();
  $('#btnReanalyze').onclick = async () => {
    if (!S.cid) return;
    const th = parseFloat($('#thr').value);
    await api('/api/reanalyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: S.cid, threshold: th })
    });
    setStatus('重新分镜…', 'busy');
    startPoll();
  };
  $('#thr').oninput = e => { $('#thrVal').textContent = parseFloat(e.target.value).toFixed(2); };
  $('#btnFit').onclick = () => tl.fit();
  $('#btnZoomIn').onclick = () => zoomAt(1.6, 0.5);
  $('#btnZoomOut').onclick = () => zoomAt(1 / 1.6, 0.5);

  // ------------------------------------------------------------- 缩放滑轨
  const ZMIN = 0.5;   // 最小可视 0.5 秒

  function durToSlider(d) {
    const maxD = Math.max(1, tl.duration || 1);
    if (d >= maxD) return 0;
    const r = Math.log(maxD / d) / Math.log(maxD / ZMIN);
    return clamp(r, 0, 1) * 1000;
  }
  function sliderToDur(v) {
    const maxD = Math.max(1, tl.duration || 1);
    const r = clamp(v / 1000, 0, 1);
    return maxD * Math.pow(ZMIN / maxD, r);
  }
  function zoomAt(factor, anchorRatio) {
    const ax = (anchorRatio == null ? 0.5 : anchorRatio) * tl.W;
    tl.zoom(factor, ax);
  }
  function fmtZoom(d) {
    if (!tl.duration) return '—';
    if (d >= tl.duration * 0.999) return '全片';
    if (d >= 1) return d.toFixed(d < 10 ? 1 : 0) + 's';
    return (d * 1000).toFixed(0) + 'ms';
  }
  const zsEl = $('#zoomSlider');
  zsEl.addEventListener('input', () => {
    if (!tl.duration) return;
    const nd = sliderToDur(+zsEl.value);
    const center = tl.viewT0 + tl.viewDur / 2;
    tl.viewDur = clamp(nd, ZMIN, tl.duration);
    tl.viewT0 = clamp(center - tl.viewDur / 2, 0, Math.max(0, tl.duration - tl.viewDur));
    tl.draw();
  });
  function syncZoomUI(t) {
    if (!t || !t.duration) { $('#zoomVal').textContent = '—'; return; }
    const v = durToSlider(t.viewDur);
    if (document.activeElement !== zsEl) zsEl.value = v;
    $('#zoomVal').textContent = fmtZoom(t.viewDur);
  }

  // ------------------------------------------------------------- 快捷键
  const ACTIONS = [
    { g: '播放', id: 'play', name: '播放 / 暂停', def: 'space' },
    { g: '播放', id: 'frameBack', name: '退一帧', def: ',' },
    { g: '播放', id: 'frameFwd', name: '进一帧', def: '.' },
    { g: '播放', id: 'back1s', name: '后退 1 秒（Shift ×5）', def: 'arrowleft' },
    { g: '播放', id: 'fwd1s', name: '前进 1 秒（Shift ×5）', def: 'arrowright' },
    { g: '播放', id: 'prevShot', name: '上一镜', def: '[' },
    { g: '播放', id: 'nextShot', name: '下一镜', def: ']' },
    { g: '编辑', id: 'split', name: '在播放头处切开', def: 's' },
    { g: '编辑', id: 'delShot', name: '删除当前镜头并合并', def: 'delete' },
    { g: '时间线', id: 'fit', name: '全片', def: 'f' },
    { g: '时间线', id: 'zoomIn', name: '放大时间线', def: '=' },
    { g: '时间线', id: 'zoomOut', name: '缩小时间线', def: '-' },
    { g: '文件', id: 'open', name: '打开影片', def: 'ctrl+o' },
    { g: '文件', id: 'save', name: '保存', def: 'ctrl+s' },
    { g: '文件', id: 'export', name: '导出', def: 'ctrl+e' },
    { g: '文件', id: 'shortcuts', name: '快捷键设置', def: '?' },
  ];

  const KEY_STORE = 'cinegraph.keymap.v1';
  const DEFAULTS = {};
  ACTIONS.forEach(a => { DEFAULTS[a.id] = a.def; });
  let KEYMAP = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY_STORE) || '{}');
    Object.keys(saved).forEach(k => { if (k in DEFAULTS) KEYMAP[k] = saved[k]; });
  } catch (e) { /* ignore */ }

  let byKey = {};
  function rebuildByKey() {
    byKey = {};
    Object.keys(KEYMAP).forEach(id => { if (KEYMAP[id]) byKey[KEYMAP[id]] = id; });
  }
  rebuildByKey();
  function saveKeys() { try { localStorage.setItem(KEY_STORE, JSON.stringify(KEYMAP)); } catch (e) { /* ignore */ } }

  function keyName(e) {
    let k = e.key;
    if (k === ' ') k = 'space';
    k = String(k).toLowerCase();
    if (e.ctrlKey) return 'ctrl+' + k;
    if (e.altKey) return 'alt+' + k;
    return k;
  }
  function prettyKey(k) {
    if (!k) return '—';
    return k.split('+').map(p => {
      if (p === 'space') return 'Space';
      if (p === 'ctrl') return 'Ctrl';
      if (p === 'alt') return 'Alt';
      if (p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    }).join(' + ');
  }

  const RUN = {
    play: () => { if (video.paused) video.play(); else video.pause(); },
    frameBack: () => step(-1),
    frameFwd: () => step(1),
    back1s: e => seekTo(videoTime() - (e.shiftKey ? 5 : 1)),
    fwd1s: e => seekTo(videoTime() + (e.shiftKey ? 5 : 1)),
    prevShot: () => { if (S.proj && S.sel > 0) selectShot(S.sel - 1, true); },
    nextShot: () => { if (S.proj && S.sel < S.proj.shots.length - 1) selectShot(S.sel + 1, true); },
    split: () => { if (S.proj) insertShotAt(videoTime()); },
    delShot: () => { if (S.proj && S.sel >= 0) deleteShot(S.sel); },
    fit: () => tl.fit(),
    zoomIn: () => zoomAt(1.6, 0.5),
    zoomOut: () => zoomAt(1 / 1.6, 0.5),
    open: () => pickViaInput(),
    save: () => save(true),
    export: () => { if (S.proj) exportDialog(); },
    shortcuts: () => shortcutsDialog(),
  };

  let capture = null;

  function startCapture(id) { capture = { id: id }; renderKeyRows(); }
  function stopCapture() { capture = null; renderKeyRows(); }

  function renderKeyRows() {
    const box = document.querySelector('#kbody');
    if (!box) return;
    box.innerHTML = '';
    let lastG = '';
    ACTIONS.forEach(a => {
      if (a.g !== lastG) { box.appendChild(el('div', 'kgroup', a.g)); lastG = a.g; }
      const cap = capture && capture.id === a.id;
      const row = el('div', 'krow' + (cap ? ' capturing' : ''));
      row.appendChild(el('span', 'kname', a.name));
      const kk = el('span', 'kkey' + (KEYMAP[a.id] ? '' : ' empty'));
      kk.textContent = cap ? '按下新键…' : prettyKey(KEYMAP[a.id]);
      row.appendChild(kk);
      const btn = el('button', null, cap ? '取消' : '改');
      btn.onclick = () => {
        if (cap) { stopCapture(); return; }
        startCapture(a.id);
      };
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  function shortcutsDialog() {
    const d = modal('快捷键设置', '<div id="kbody" style="width:560px"></div>', '');
    const foot = el('div', 'foot');
    foot.style.justifyContent = 'space-between';
    const reset = el('button', null, '恢复默认');
    reset.onclick = () => {
      KEYMAP = Object.assign({}, DEFAULTS);
      saveKeys(); rebuildByKey(); renderKeyRows();
      setStatus('快捷键已恢复默认', '');
    };
    const done = el('button', 'on', '完成');
    done.onclick = () => { stopCapture(); closeModal(); };
    foot.appendChild(reset);
    foot.appendChild(done);
    d.appendChild(foot);
    renderKeyRows();
  }

  document.addEventListener('keydown', e => {
    if (capture) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { stopCapture(); return; }
      const k = keyName(e);
      const owner = Object.keys(KEYMAP).find(a => KEYMAP[a] === k && a !== capture.id);
      if (owner) KEYMAP[owner] = '';
      KEYMAP[capture.id] = k;
      saveKeys(); rebuildByKey();
      const doneId = capture.id;
      capture = null;
      renderKeyRows();
      const a = ACTIONS.find(x => x.id === doneId);
      setStatus('「' + (a ? a.name : doneId) + '」已绑定到 ' + prettyKey(k), '');
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if ($('#mask').classList.contains('show')) {
      if (e.key === 'Escape') closeModal();
      return;
    }
    const act = byKey[keyName(e)];
    if (!act || !RUN[act]) return;
    e.preventDefault();
    RUN[act](e);
  });

  window.addEventListener('beforeunload', e => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------- boot
  async function loadById(cid) {
    try {
      const j = await api('/api/project?id=' + encodeURIComponent(cid));
      S.cid = cid; S.proj = j.project; S.sel = -1; S.ana = null;
      rememberOpen(cid);
      $('#projTitle').textContent = S.proj.title || cid;
      document.title = (S.proj.title || '帧鉴') + ' · 帧鉴';
      const v = $('#video');
      v.src = '/media?id=' + S.cid;
      v.load();
      $('#hud').textContent = S.proj.video || '';
      $('#dropzone').classList.add('hide');
      renderShots(); clearEditor();
      const st = await api('/api/status?id=' + cid);
      if (st.ready) await loadAnalysis();
      else { setStatus('分析中…', 'busy'); startPoll(); }
      restorePos(cid);
    } catch (e) {
      try { localStorage.removeItem('cinegraph.last'); } catch (_) { /* ignore */ }
      setStatus(e.message, 'err');
    }
  }

  /* 记住播放位置，刷新后接着看 */
  let posTimer = null;
  function savePos() {
    if (!S.cid) return;
    try { localStorage.setItem('cinegraph.pos', JSON.stringify({ cid: S.cid, t: videoTime() })); } catch (e) { /* ignore */ }
  }
  function restorePos(cid) {
    let p = null;
    try { p = JSON.parse(localStorage.getItem('cinegraph.pos') || 'null'); } catch (e) { /* ignore */ }
    if (!p || p.cid !== cid || !(p.t > 1)) return;
    const v = $('#video');
    const go = () => { try { v.currentTime = p.t; tl.setPlayhead(p.t); updateTC(); } catch (e) { /* ignore */ } };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  }

  // ------------------------------------------------------------- 可拖拽分隔条
  const LAYOUT_KEY = 'cinegraph.layout.v1';
  const LAYOUT = { tl: 268, side: 392 };
  try { Object.assign(LAYOUT, JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}')); } catch (e) { /* ignore */ }
  try {
    const qs = new URLSearchParams(location.search);
    const a = parseInt(qs.get('tl'), 10);
    const b = parseInt(qs.get('side'), 10);
    if (a > 0) LAYOUT.tl = a;
    if (b > 0) LAYOUT.side = b;
  } catch (e) { /* ignore */ }

  function applyLayout() {
    const r = document.documentElement.style;
    r.setProperty('--tlh', LAYOUT.tl + 'px');
    r.setProperty('--sidew', LAYOUT.side + 'px');
  }
  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(LAYOUT)); } catch (e) { /* ignore */ }
  }
  function clampLayout() {
    const H = window.innerHeight, W = window.innerWidth;
    LAYOUT.tl = clamp(Math.round(LAYOUT.tl), 110, Math.max(140, H - 240));
    LAYOUT.side = clamp(Math.round(LAYOUT.side), 260, Math.max(280, W - 460));
  }

  function bindSplit(el, axis) {
    if (!el) return;
    const key = axis === 'h' ? 'tl' : 'side';
    let start = 0, base = 0, active = false;

    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      active = true;
      el.classList.add('on');
      document.body.classList.add('resizing', axis);
      start = axis === 'h' ? e.clientY : e.clientX;
      base = LAYOUT[key];
      setStatus(axis === 'h' ? '时间线高度 ' + base + 'px' : '侧栏宽度 ' + base + 'px', '');

      const move = ev => {
        if (!active) return;
        const cur = axis === 'h' ? ev.clientY : ev.clientX;
        LAYOUT[key] = base - (cur - start);
        clampLayout();
        applyLayout();
        setStatus(axis === 'h' ? '时间线高度 ' + LAYOUT.tl + 'px' : '侧栏宽度 ' + LAYOUT.side + 'px', '');
      };
      const up = () => {
        active = false;
        el.classList.remove('on');
        document.body.classList.remove('resizing', axis);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        saveLayout();
        setStatus('就绪', '');
        if (tl) tl.draw();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    el.addEventListener('dblclick', () => {
      if (axis === 'h') LAYOUT.tl = 268; else LAYOUT.side = 392;
      applyLayout(); saveLayout();
      if (tl) tl.draw();
    });
  }

  function boot() {
    tl = new Timeline($('#tl'), {
      cid: null,
      onSeek: t => { if (S.proj) seekTo(t); },
      onSelect: i => selectShot(i, false),
      onViewChange: t => syncZoomUI(t)
    });
    fetch('/api/ping').then(r => r.json()).then(j => {
      setStatus('就绪 · ffmpeg ' + (j.ffmpeg || '?'), '');
    }).catch(() => setStatus('后端未连接', 'err'));
    tl.draw();
    clampLayout();
    applyLayout();
    bindSplit($('#splitH'), 'h');
    bindSplit($('#splitV'), 'v');
    window.addEventListener('resize', () => { clampLayout(); applyLayout(); });
    bindDrop();
    bindFileInput();
    loadRecent();
    BOOT_Q = new URLSearchParams(location.search);
    const q = BOOT_Q;
    const oid = q.get('open') || lastOpen();
    if (oid) loadById(oid);
    if (q.get('keys')) setTimeout(() => shortcutsDialog(), 500);
  }
  boot();
})();
