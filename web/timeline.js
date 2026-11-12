/* 帧鉴 · 时间线组件 */
(function () {
  'use strict';

  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

  // BT.601 TV-range YUV -> RGB
  function yuv2rgb(Y, U, V) {
    const y = clamp((Y - 16) * 255 / 219, 0, 255);
    const u = U - 128, v = V - 128;
    return [
      clamp(y + 1.402 * v, 0, 255),
      clamp(y - 0.344136 * u - 0.714136 * v, 0, 255),
      clamp(y + 1.772 * u, 0, 255)
    ];
  }
  function rgb(c) { return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'; }

  function fmtTC(t, withFrames) {
    t = Math.max(0, t);
    const h = Math.floor(t / 3600);
    const m = Math.floor(t % 3600 / 60);
    const s = Math.floor(t % 60);
    const f = Math.round((t - Math.floor(t)) * 100);
    const p = n => String(n).padStart(2, '0');
    return p(h) + ':' + p(m) + ':' + p(s) + (withFrames ? '.' + p(f) : '');
  }

  class Timeline {
    constructor(canvas, opts) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts || {};
      this.duration = 0;
      this.shots = [];
      this.sections = [];
      this.strip = null;
      this.wave = null;
      this.metrics = null;
      this.images = [];
      this.imgsReady = false;
      this.viewT0 = 0;
      this.viewDur = 1;
      this.playhead = 0;
      this.sel = -1;
      this.hoverT = -1;
      this.drag = null;
      this.W = 800; this.H = 180;
      this._bind();
      this._ro = new ResizeObserver(() => { this._resize(); this.draw(); });
      this._ro.observe(canvas.parentElement || canvas);
      this._resize();
    }

    // ------------------------------------------------ data
    setData(d) {
      const changedStrip = d.strip && d.strip.files &&
        JSON.stringify((this.strip && this.strip.files) || []) !== JSON.stringify(d.strip.files);
      if (d.duration != null) this.duration = d.duration;
      if (d.shots) this.shots = d.shots;
      if (d.sections) this.sections = d.sections;
      if (d.wave) this.wave = d.wave;
      if (d.metrics) this.metrics = d.metrics;
      if (d.strip) {
        this.strip = d.strip;
        if (changedStrip) this._loadImages();
      }
      if (this.viewDur <= 1 && this.duration > 0) this.fit();
      this.draw();
    }

    _loadImages() {
      const s = this.strip;
      this.images = [];
      this.imgsReady = false;
      if (!s || !s.files || !s.files.length) return;
      let left = s.files.length;
      s.files.forEach((fn, i) => {
        const img = new Image();
        img.onload = img.onerror = () => {
          left--;
          if (left <= 0) { this.imgsReady = true; this.draw(); }
        };
        img.src = '/cache/' + this.opts.cid + '/' + fn;
        this.images[i] = img;
      });
    }

    setPlayhead(t) {
      this.playhead = t;
      this._needRedraw = true;
      this.draw();
    }
    setSelected(i) { this.sel = i; this.draw(); }

    // ------------------------------------------------ view
    fit() {
      this.viewT0 = 0;
      this.viewDur = Math.max(1, this.duration);
      this.draw();
    }
    x2t(x) { return this.viewT0 + (x / this.W) * this.viewDur; }
    t2x(t) { return (t - this.viewT0) / this.viewDur * this.W; }
    get pxPerSec() { return this.W / this.viewDur; }

    zoom(factor, anchorX) {
      if (anchorX == null) anchorX = this.W / 2;
      const at = this.x2t(anchorX);
      let nd = this.viewDur / factor;
      nd = clamp(nd, 0.25, Math.max(1, this.duration));
      this.viewT0 = at - (anchorX / this.W) * nd;
      this.viewDur = nd;
      this._clampView();
      this.draw();
    }
    pan(dx) {
      this.viewT0 -= (dx / this.W) * this.viewDur;
      this._clampView();
      this.draw();
    }
    _clampView() {
      const maxT0 = Math.max(0, this.duration - this.viewDur);
      this.viewT0 = clamp(this.viewT0, 0, maxT0);
    }
    scrollTo(t) {
      if (t < this.viewT0 || t > this.viewT0 + this.viewDur) {
        this.viewT0 = clamp(t - this.viewDur * 0.35, 0, Math.max(0, this.duration - this.viewDur));
        this.draw();
      }
    }

    // ------------------------------------------------ sizing
    _resize() {
      const r = this.cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.W = Math.max(120, r.width);
      this.H = Math.max(80, r.height);
      this.cv.width = Math.round(this.W * dpr);
      this.cv.height = Math.round(this.H * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ------------------------------------------------ layout
    _rows() {
      const H = this.H;
      const ruler = 17;
      let rest = H - ruler;
      const pps = this.pxPerSec;
      // 各层随整体高度按比例分配，时间线拉高时波形和镜头轨道一起长
      const col = Math.round(clamp(rest * 0.045, 14, 34));
      const lum = Math.round(clamp(rest * 0.028, 9, 22));
      const shot = Math.round(clamp(rest * 0.17, 24, 88));
      const sec = (this.sections && this.sections.length) ? Math.round(clamp(rest * 0.06, 18, 34)) : 0;
      const remain = Math.max(60, rest - col - lum - shot - sec);
      const thWant = pps / 2.35;
      const th = Math.round(clamp(Math.max(thWant, remain * 0.30), 34, Math.min(124, remain * 0.55)));
      const wave = Math.max(14, remain - th);
      let y = ruler;
      const r = { ruler: [0, ruler], thumb: [y, th] }; y += th;
      r.color = [y, col]; y += col;
      r.luma = [y, lum]; y += lum;
      r.wave = [y, wave]; y += wave;
      r.shot = [y, shot]; y += shot;
      if (sec) { r.sec = [y, sec]; y += sec; }
      return r;
    }

    // ------------------------------------------------ draw
    draw() {
      const ctx = this.ctx, W = this.W, H = this.H;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#101318';
      ctx.fillRect(0, 0, W, H);
      const R = this._rows();

      if (!this.duration) {
        ctx.fillStyle = '#48525e';
        ctx.font = '12px system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('打开影片后，这里会出现缩略图条 / 色温带 / 波形 / 镜头轨道', W / 2, H / 2);
        return;
      }

      this._drawThumb(R);
      this._drawColorBand(R);
      this._drawLumaBand(R);
      this._drawWave(R);
      this._drawShots(R);
      this._drawSections(R);
      this._drawRuler(R);
      this._drawPlayhead(R);
      this._drawHover(R);
      if (this.opts.onViewChange) this.opts.onViewChange(this);
    }

    _drawRuler(R) {
      const ctx = this.ctx, W = this.W;
      const [y, h] = R.ruler;
      ctx.fillStyle = '#121519';
      ctx.fillRect(0, y, W, h);
      // 选一个好看的刻度间隔
      const target = 78; // px per tick
      const cands = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
      let step = cands[cands.length - 1];
      for (const c of cands) { if (c * this.pxPerSec >= target) { step = c; break; } }
      const t0 = Math.floor(this.viewT0 / step) * step;
      ctx.font = '10px ui-monospace,Consolas,monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let t = t0; t <= this.viewT0 + this.viewDur + step; t += step) {
        const x = Math.round(this.t2x(t)) + 0.5;
        if (x < -60 || x > W + 60) continue;
        ctx.strokeStyle = '#39424e';
        ctx.beginPath(); ctx.moveTo(x, h - 5); ctx.lineTo(x, h); ctx.stroke();
        ctx.fillStyle = '#7b8794';
        ctx.fillText(step >= 1 ? fmtTC(t).slice(3) : fmtTC(t) + '', x + 4, h / 2 - 1);
      }
      ctx.strokeStyle = '#262c35';
      ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(W, h - 0.5); ctx.stroke();
    }

    _drawThumb(R) {
      const ctx = this.ctx, W = this.W;
      const [y, h] = R.thumb;
      const s = this.strip;
      const pps = this.pxPerSec;

      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(0, y, W, h);

      if (!s || !s.files || !s.files.length || !this.imgsReady) {
        ctx.fillStyle = '#3a424c';
        ctx.font = '11px system-ui,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('缩略图载入中…', W / 2, y + h / 2);
        return;
      }

      const fps = s.fps || 1;
      const per = s.per || 400, cols = s.cols || 20, rowsc = s.rows || 20;
      const cw = s.cell_w, ch = s.cell_h, pad = 2;
      const ar = cw / ch;

      // 单行时每格宽度由缩放决定；高度由容器决定。两者比例差太多就拆多行，
      // 每行铺满宽度、显示不同时间段，避免画面被纵向拉伸。
      let step = 1 / fps;
      if (pps * step < 3) step = 3 / pps;
      const dwSingle = step * pps;
      const naturalW = h * ar;
      let nRows = 1;
      if (dwSingle >= 6 && dwSingle < naturalW * 0.45) {
        nRows = clamp(Math.round(naturalW / dwSingle), 2, 4);
      }
      const rowH = h / nRows;
      const spanPerRow = this.viewDur / nRows;

      for (let r = 0; r < nRows; r++) {
        const rowStart = this.viewT0 + r * spanPerRow;
        const rowEnd = rowStart + spanPerRow;
        const rowPps = W / spanPerRow;
        let rs = 1 / fps;
        if (rs * rowPps < 4) rs = 4 / rowPps;
        const dw = rs * rowPps;
        const y0 = y + r * rowH;
        const wantAr = dw / rowH;

        for (let t = Math.floor(rowStart / rs) * rs; t < rowEnd; t += rs) {
          const fi = Math.max(0, Math.floor(t * fps));
          const sheet = Math.floor(fi / per);
          const img = this.images[sheet];
          if (!img || !img.width) continue;
          const cell = fi % per, col = cell % cols, crow = Math.floor(cell / cols);
          if (crow >= rowsc) continue;
          const x = (t - rowStart) * rowPps;
          if (x > W || x + dw < 0) continue;
          const bx = col * (cw + pad), by = crow * (ch + pad);
          let sx = bx, sy = by, sw = cw, sh = ch;
          if (wantAr < ar) { sw = ch * wantAr; sx = bx + (cw - sw) / 2; }
          else { sh = cw / wantAr; sy = by + (ch - sh) / 2; }
          ctx.drawImage(img, sx, sy, sw, sh, x, y0, dw + 0.5, rowH);
        }

        if (r > 0) {
          ctx.strokeStyle = 'rgba(0,0,0,.6)';
          ctx.beginPath(); ctx.moveTo(0, y0 + 0.5); ctx.lineTo(W, y0 + 0.5); ctx.stroke();
        }
      }

      // 上下描边
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y + h - 0.5); ctx.lineTo(W, y + h - 0.5); ctx.stroke();
    }

    _drawColorBand(R) {
      const ctx = this.ctx, W = this.W;
      const [y, h] = R.color;
      const m = this.metrics;
      ctx.fillStyle = '#14181d';
      ctx.fillRect(0, y, W, h);
      if (!m || !m.rows || !m.rows.length) return;
      if (!this._uvRange) {
        let umin = 999, umax = -999, vmin = 999, vmax = -999;
        m.rows.forEach(r => {
          if (r[2] < umin) umin = r[2]; if (r[2] > umax) umax = r[2];
          if (r[3] < vmin) vmin = r[3]; if (r[3] > vmax) vmax = r[3];
        });
        this._uvRange = { umin, umax, vmin, vmax };
      }
      const rg = this._uvRange;
      const hu = Math.max(3, (rg.umax - rg.umin) / 2);
      const hv = Math.max(3, (rg.vmax - rg.vmin) / 2);
      const step = m.step || 0.5;
      const rows = m.rows;
      for (let x = 0; x < W; x++) {
        const t = this.x2t(x + 0.5);
        const i = clamp(Math.floor(t / step), 0, rows.length - 1);
        const r = rows[i];
        const su = clamp((r[2] - 128) / hu, -1, 1);
        const sv = clamp((r[3] - 128) / hv, -1, 1);
        const U = 128 + su * 38, V = 128 + sv * 38;
        const c = yuv2rgb(clamp(r[1], 20, 235), U, V);
        const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
        const boost = 1.9;
        ctx.fillStyle = rgb([
          clamp(lum + (c[0] - lum) * boost, 0, 255),
          clamp(lum + (c[1] - lum) * boost, 0, 255),
          clamp(lum + (c[2] - lum) * boost, 0, 255)
        ]);
        ctx.fillRect(x, y, 1, h);
      }
    }

    _drawLumaBand(R) {
      const ctx = this.ctx, W = this.W;
      const [y, h] = R.luma;
      const m = this.metrics;
      ctx.fillStyle = '#14181d';
      ctx.fillRect(0, y, W, h);
      if (!m || !m.rows || !m.rows.length) return;
      const step = m.step || 0.5, rows = m.rows;
      for (let x = 0; x < W; x++) {
        const t = this.x2t(x + 0.5);
        const i = clamp(Math.floor(t / step), 0, rows.length - 1);
        const v = clamp((rows[i][1] - 16) * 255 / 219, 0, 255);
        ctx.fillStyle = 'rgb(' + (v | 0) + ',' + (v | 0) + ',' + (v | 0) + ')';
        ctx.fillRect(x, y, 1, h);
      }
    }

    _drawWave(R) {
      const ctx = this.ctx, W = this.W;
      const [y, h] = R.wave;
      const cy = y + h / 2;
      ctx.fillStyle = '#0d1116';
      ctx.fillRect(0, y, W, h);
      // 中线
      ctx.strokeStyle = '#1c222a';
      ctx.beginPath(); ctx.moveTo(0, cy + 0.5); ctx.lineTo(W, cy + 0.5); ctx.stroke();
      const w = this.wave;
      if (!w || !w.peaks || !w.peaks.length) return;
      const hop = (w.hop || 50) / 1000;
      const peaks = w.peaks;
      const tEnd = this.viewT0 + this.viewDur;
      const iEnd = Math.min(peaks.length, Math.ceil(tEnd / hop) + 1);
      // 逐像素柱状
      for (let x = 0; x < W; x++) {
        const ta = this.x2t(x), tb = this.x2t(x + 1);
        let i0 = Math.floor(ta / hop), i1 = Math.ceil(tb / hop);
        i0 = clamp(i0, 0, peaks.length - 1);
        i1 = clamp(i1, i0 + 1, iEnd);
        let m = 0;
        for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
        if (m <= 0.0005) continue;
        const ph = Math.max(1, m * (h / 2 - 1));
        ctx.fillStyle = m > 0.62 ? '#7fb4dc' : '#476f92';
        ctx.fillRect(x, cy - ph, 1, ph * 2);
      }
    }

    _drawShots(R) {
      const ctx = this.ctx, W = this.W;
      const [y, h] = R.shot;
      ctx.fillStyle = '#171d24';
      ctx.fillRect(0, y, W, h);
      const shots = this.shots || [];
      ctx.font = '10px system-ui,sans-serif';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i];
        const x0 = this.t2x(s.t);
        const x1 = this.t2x(s.t + s.dur);
        if (x1 < -4 || x0 > W + 4) continue;
        const w = Math.max(1, x1 - x0 - 1);
        const sel = i === this.sel;
        const filled = s.scale || s.note || s.func;
        ctx.fillStyle = sel ? '#5a4612' : (filled ? '#26404f' : '#2f3843');
        ctx.fillRect(x0, y + 1, w, h - 2);
        ctx.strokeStyle = sel ? '#ffb340' : '#4b5765';
        ctx.lineWidth = sel ? 1.5 : 1;
        ctx.strokeRect(x0 + 0.5, y + 1.5, w, h - 3);
        ctx.lineWidth = 1;
        if (w > 26) {
          ctx.fillStyle = sel ? '#ffcf7a' : (filled ? '#8fb6d6' : '#5b6773');
          const txt = (s.scale ? s.scale.slice(0, 2) : '') + (w > 60 && s.move ? '·' + s.move.slice(0, 2) : '');
          ctx.fillText(txt, x0 + 4, y + h / 2);
        }
        // 轨道拉高时补一行镜号/时长
        if (h >= 40 && w > 34) {
          ctx.fillStyle = sel ? '#e8b45e' : '#6b7a89';
          ctx.font = '9px ui-monospace,Consolas,monospace';
          const line2 = String(i + 1).padStart(3, '0') + (w > 70 ? '  ' + s.dur.toFixed(1) + 's' : '');
          ctx.fillText(line2, x0 + 4, y + h - 9);
        }
      }
      ctx.strokeStyle = '#262c35';
      ctx.beginPath(); ctx.moveTo(0, y - 0.5); ctx.lineTo(W, y - 0.5); ctx.stroke();
    }

    _drawSections(R) {
      if (!R.sec) return;
      const ctx = this.ctx, W = this.W;
      const [y, h] = R.sec;
      ctx.fillStyle = '#0d1116';
      ctx.fillRect(0, y, W, h);
      const secs = this.sections || [];
      secs.forEach(s => {
        const x0 = this.t2x(s.t), x1 = this.t2x(s.t + s.dur);
        if (x1 < -4 || x0 > W + 4) return;
        ctx.fillStyle = '#2a2036';
        ctx.fillRect(x0, y + 2, Math.max(2, x1 - x0 - 1), h - 4);
        ctx.strokeStyle = '#6b4a9e';
        ctx.strokeRect(x0 + 0.5, y + 2.5, Math.max(2, x1 - x0 - 1), h - 5);
        if (x1 - x0 > 50) {
          ctx.fillStyle = '#c0a8e8';
          ctx.font = '10px system-ui,sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(s.title || '段落', x0 + 5, y + h / 2);
        }
      });
    }

    _drawPlayhead(R) {
      const ctx = this.ctx, W = this.W, H = this.H;
      const x = Math.round(this.t2x(this.playhead)) + 0.5;
      if (x < -20 || x > W + 20) return;
      ctx.strokeStyle = '#ff5c5c';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = '#ff5c5c';
      ctx.beginPath();
      ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); ctx.closePath();
      ctx.fill();
    }

    _drawHover(R) {
      if (this.hoverT < 0) return;
      const ctx = this.ctx;
      const x = this.t2x(this.hoverT);
      if (x < 0 || x > this.W) return;
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.beginPath(); ctx.moveTo(x, R.ruler[0] + R.ruler[1]); ctx.lineTo(x, this.H); ctx.stroke();
      const label = fmtTC(this.hoverT, true);
      ctx.font = '10px ui-monospace,Consolas,monospace';
      const w = ctx.measureText(label).width + 10;
      let bx = x + 6; if (bx + w > this.W) bx = x - w - 6;
      ctx.fillStyle = 'rgba(10,13,17,.92)';
      ctx.fillRect(bx, R.ruler[0] + 1, w, 14);
      ctx.fillStyle = '#c8d1dc';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 5, R.ruler[0] + 8);
    }

    // ------------------------------------------------ interaction
    _hitShot(x) {
      const t = this.x2t(x);
      for (let i = 0; i < this.shots.length; i++) {
        const s = this.shots[i];
        if (t >= s.t && t < s.t + s.dur) return i;
      }
      return -1;
    }

    _bind() {
      const cv = this.cv;
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const ax = e.clientX - r.left;
        if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          this.zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, ax);
        } else {
          this.pan(-e.deltaX * 1.2);
        }
      }, { passive: false });

      cv.addEventListener('mousedown', e => {
        const r = cv.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const R = this._rows();
        if (e.button === 0) {
          if (y >= R.shot[0] && y < R.shot[0] + R.shot[1]) {
            const i = this._hitShot(x);
            if (i >= 0) { this.sel = i; this.opts.onSelect && this.opts.onSelect(i); this.draw(); return; }
          }
          // 定位 + 可开始拖动
          const t = clamp(this.x2t(x), 0, this.duration);
          this.opts.onSeek && this.opts.onSeek(t);
          this.drag = { x0: e.clientX, t0: this.viewT0, moved: false };
        } else if (e.button === 1) {
          this.drag = { x0: e.clientX, t0: this.viewT0, moved: false, mid: true };
          e.preventDefault();
        }
      });

      window.addEventListener('mousemove', e => {
        const r = cv.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          this.hoverT = this.x2t(e.clientX - r.left);
        } else this.hoverT = -1;
        if (this.drag) {
          const dx = e.clientX - this.drag.x0;
          if (Math.abs(dx) > 3) this.drag.moved = true;
          if (this.drag.moved) {
            this.viewT0 = this.drag.t0 - (dx / this.W) * this.viewDur;
            this._clampView();
          }
        }
        this.draw();
      });

      window.addEventListener('mouseup', () => { this.drag = null; });

      cv.addEventListener('dblclick', e => {
        const r = cv.getBoundingClientRect();
        this.fit();
      });
    }
  }

  window.Timeline = Timeline;
  window.fmtTC = fmtTC;
})();
