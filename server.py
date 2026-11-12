#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
帧鉴 · Cinegraph
本地视频拉片工作台 — 自动分镜 / 时间线 / 逐镜注解 / 导出
零第三方依赖（仅需 ffmpeg + ffprobe）
"""
import os, sys, json, re, time, shutil, subprocess, threading, hashlib, mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
from array import array

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, "cache")
PROJ = os.path.join(DATA, "projects")
PORT = int(os.environ.get("CINEGRAPH_PORT", "7788"))
for p in (DATA, CACHE, PROJ):
    os.makedirs(p, exist_ok=True)

# ---------------------------------------------------------------- ffmpeg

def _find(binname):
    env = os.environ.get("CINEGRAPH_" + binname.upper())
    if env and os.path.isfile(env):
        return env
    cands = [r"C:\ffmpeg6.0\bin\%s.exe" % binname, r"C:\ffmpeg\bin\%s.exe" % binname]
    for c in cands:
        if os.path.isfile(c):
            return c
    w = shutil.which(binname)
    if w:
        return w
    return binname

FFMPEG = _find("ffmpeg")
FFPROBE = _find("ffprobe")

def run(cmd, cwd=None, timeout=1800, capture=True):
    kw = dict(cwd=cwd, timeout=timeout)
    if capture:
        kw["stdout"] = subprocess.PIPE
        kw["stderr"] = subprocess.PIPE
    return subprocess.run(cmd, **kw)

# ---------------------------------------------------------------- helpers

def cid_of(path):
    return hashlib.sha1(os.path.abspath(path).encode("utf-8", "ignore")).hexdigest()[:16]

def jdump(obj, path):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)

def jload(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

# ---------------------------------------------------------------- analyze

PROGRESS = {}
PLOCK = threading.Lock()

def set_prog(cid, stage, pct, msg=""):
    with PLOCK:
        PROGRESS[cid] = {"stage": stage, "pct": round(pct, 3), "msg": msg, "at": time.time()}
    jdump(PROGRESS[cid], os.path.join(CACHE, cid, "progress.json"))

def probe(video):
    r = run([FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", video])
    j = json.loads(r.stdout.decode("utf-8", "ignore") or "{}")
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), {})
    num, den = (v.get("avg_frame_rate") or "30/1").split("/")
    fps = (float(num) / float(den)) if float(den) else 30.0
    return {
        "duration": float(j.get("format", {}).get("duration") or 0),
        "size": int(j.get("format", {}).get("size") or 0),
        "bitrate": int(j.get("format", {}).get("bit_rate") or 0),
        "width": int(v.get("width") or 0),
        "height": int(v.get("height") or 0),
        "fps": round(fps, 3),
        "vcodec": v.get("codec_name", ""),
        "acodec": a.get("codec_name", ""),
        "achannels": int(a.get("channels") or 0),
        "asample": int(a.get("sample_rate") or 0),
        "has_audio": bool(a),
    }

def run_progress(cmd, duration, on_pct, cwd=None, timeout=7200):
    """跑 ffmpeg，用 -progress pipe:1 的 out_time 换算真实进度。
    后台线程读 progress，主循环按固定节拍回调 on_pct ——
    这样即使 ffmpeg 长时间不吐进度（tile 攒帧），上层也能推进估算。"""
    p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, bufsize=1,
                         encoding="utf-8", errors="ignore")
    last_p = [0.0]
    done = threading.Event()

    def reader():
        try:
            for line in p.stdout:
                line = line.strip()
                if line.startswith("out_time_us="):
                    v = line.split("=", 1)[1]
                    if v.isdigit() and duration > 0:
                        last_p[0] = min(1.0, (int(v) / 1000000.0) / duration)
                elif line == "progress=end":
                    last_p[0] = 1.0
        except Exception:
            pass
        done.set()

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    deadline = time.time() + timeout
    while not done.wait(0.4):
        on_pct(last_p[0])
        if time.time() > deadline:
            try:
                p.kill()
            except Exception:
                pass
            break
    try:
        p.wait(timeout=30)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass
    on_pct(1.0)
    return p.returncode

def parse_cuts(d):
    f = os.path.join(d, "scenes.txt")
    cuts, t, score = [], 0.0, 0.0
    if os.path.exists(f):
        with open(f, "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                m = re.search(r"pts_time:([\d.]+)", line)
                if m:
                    t = float(m.group(1)); continue
                m = re.search(r"scene_score=([\d.]+)", line)
                if m:
                    score = float(m.group(1))
                    cuts.append({"t": round(t, 3), "score": round(score, 3)})
    return cuts

def parse_stats(d):
    f = os.path.join(d, "stats.txt")
    rows, t, cur = [], None, {}
    if os.path.exists(f):
        with open(f, "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                m = re.search(r"pts_time:([\d.]+)", line)
                if m:
                    if t is not None and "YAVG" in cur:
                        rows.append([round(t, 3), round(cur.get("YAVG", 0), 1),
                                     round(cur.get("UAVG", 128), 1), round(cur.get("VAVG", 128), 1)])
                    t = float(m.group(1)); cur = {}; continue
                for k in ("YAVG", "UAVG", "VAVG"):
                    mm = re.search(r"signalstats\.%s=([\d.]+)" % k, line)
                    if mm:
                        cur[k] = float(mm.group(1))
    if t is not None and "YAVG" in cur:
        rows.append([round(t, 3), round(cur.get("YAVG", 0), 1),
                     round(cur.get("UAVG", 128), 1), round(cur.get("VAVG", 128), 1)])
    return {"step": 0.5, "rows": rows}

def parse_strip(d, fps, cols, cell):
    files = sorted([x for x in os.listdir(d) if x.startswith("strip_")])
    fw, fh = 0, 0
    if files:
        r = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                 "stream=width,height", "-print_format", "json", os.path.join(d, files[0])])
        try:
            s = json.loads(r.stdout.decode("utf-8", "ignore"))["streams"][0]
            fw, fh = int(s["width"]), int(s["height"])
        except Exception:
            fw, fh = cols * (cell + 2), 0
    cw = (fw - 2 * (cols - 1)) // cols if fw else 0
    ch = ((fh - 2 * 19) // 20) if fh else 0
    return {"files": files, "cols": cols, "rows": 20, "per": cols * 20,
            "fps": fps, "sheet_w": fw, "sheet_h": fh, "cell_w": cw, "cell_h": ch}

def build_all(video, d, duration, threshold=0.28, fps=1.0, cols=20, cell=160, on_pct=None):
    """一次解码，三路输出：镜头切点 / 缩略图条 / 亮度色温。"""
    for old in os.listdir(d):
        if old.startswith("strip_") or old in ("scenes.txt", "stats.txt"):
            try:
                os.remove(os.path.join(d, old))
            except Exception:
                pass
    n_sheets = max(1, int(duration * fps / (cols * 20)) + 1)
    fc = ("[0:v]split=3[a][b][c];"
          "[a]select='gt(scene,%s)',metadata=print:file=scenes.txt[o1];"
          "[b]fps=%s,scale=%d:-2,tile=%dx20:padding=2:color=0x111111[o2];"
          "[c]fps=2,signalstats,metadata=print:file=stats.txt[o3]") % (threshold, fps, cell, cols)
    devnull = "NUL" if os.name == "nt" else "/dev/null"
    cmd = [FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", video,
           "-filter_complex", fc,
           "-map", "[o1]", "-f", "null", devnull,
           "-map", "[o3]", "-f", "null", devnull,
           "-map", "[o2]", "-frames:v", str(n_sheets), "-q:v", "4", "strip_%02d.jpg",
           "-progress", "pipe:1", "-nostats"]
    return run_progress(cmd, duration, on_pct or (lambda p: None), cwd=d)

def build_wave(video, d, sr=8000, hop_ms=50):
    r = run([FFMPEG, "-hide_banner", "-v", "error", "-i", video, "-vn",
             "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"])
    buf = r.stdout or b""
    if len(buf) < 4:
        return {"hop": hop_ms, "peaks": []}
    n = len(buf) // 2
    a = array("h")
    a.frombytes(buf[:n * 2])
    if sys.byteorder == "big":
        a.byteswap()
    hop = max(1, int(sr * hop_ms / 1000.0))
    peaks = []
    for i in range(0, n, hop):
        chunk = a[i:i + hop]
        if not chunk:
            break
        peaks.append(round(max(abs(min(chunk)), abs(max(chunk))) / 32768.0, 4))
    return {"hop": hop_ms, "peaks": peaks}

def jobs_from_cuts(cuts, duration):
    ts = [0.0] + [c["t"] for c in cuts] + [duration]
    ts = sorted(set([round(x, 3) for x in ts if 0 <= x <= duration]))
    out = []
    for i in range(len(ts) - 1):
        s, e = ts[i], ts[i + 1]
        if e - s <= 0.001:
            continue
        out.append({"idx": len(out) + 1, "t": s, "dur": round(e - s, 3), "score": 0})
    sc = {round(c["t"], 3): c["score"] for c in cuts}
    for o in out:
        o["score"] = sc.get(round(o["t"], 3), 0)
    return out

def _mmss(t):
    t = max(0, int(t))
    return "%02d:%02d" % (t // 60, t % 60)

def analyze(video, cid, threshold=0.28):
    d = os.path.join(CACHE, cid)
    os.makedirs(d, exist_ok=True)
    try:
        set_prog(cid, "probe", 0.02, "读取元信息")
        meta = probe(video)
        jdump(meta, os.path.join(d, "meta.json"))
        if meta["duration"] <= 0:
            raise RuntimeError("无法读取视频时长")
        dur = meta["duration"]

        last = [-1.0]
        t0 = time.time()
        # tile 滤镜要攒满 400 帧才吐第一张图，ffmpeg 的 out_time 前半段一直停在 0。
        # 所以真实进度与时间估算取大值：进度条始终在走，且不越过 0.90。
        est = max(6.0, dur / 32.0)

        def on_pct(p):
            fake = min(0.95, (time.time() - t0) / est)
            v = p if p > fake else fake
            overall = min(0.90, 0.03 + v * 0.87)
            if overall - last[0] < 0.01 and v < 1.0:
                return
            last[0] = overall
            set_prog(cid, "decode", round(overall, 4),
                     "解码并分析 %d%% · 全片 %s" % (int(overall / 0.90 * 100), _mmss(dur)))

        set_prog(cid, "decode", 0.03, "解码并分析 0%% · 全片 %s" % _mmss(dur))
        rc = build_all(video, d, dur, threshold=threshold, on_pct=on_pct)
        if rc != 0:
            raise RuntimeError("ffmpeg 解码失败（code %s）" % rc)

        set_prog(cid, "parse", 0.92, "解析镜头切点")
        cuts = parse_cuts(d)
        jdump(cuts, os.path.join(d, "cuts.json"))
        jdump(parse_strip(d, 1.0, 20, 160), os.path.join(d, "strip.json"))
        jdump(parse_stats(d), os.path.join(d, "metrics.json"))

        set_prog(cid, "wave", 0.95, "计算音频包络")
        jdump(build_wave(video, d), os.path.join(d, "wave.json"))

        set_prog(cid, "shots", 0.98, "生成镜头表")
        jdump(jobs_from_cuts(cuts, dur), os.path.join(d, "shots.json"))
        set_prog(cid, "done", 1.0, "完成")
        return True
    except Exception as e:
        set_prog(cid, "error", 1.0, str(e))
        return False

THREADS = {}

def ensure_analysis(video, cid, force=False, threshold=0.28):
    d = os.path.join(CACHE, cid)
    done = os.path.join(d, "shots.json")
    if os.path.exists(done) and not force:
        return False
    if cid in THREADS and THREADS[cid].is_alive():
        return False
    t = threading.Thread(target=analyze, args=(video, cid, threshold), daemon=True)
    THREADS[cid] = t
    t.start()
    return True

# ---------------------------------------------------------------- http

class H(BaseHTTPRequestHandler):
    server_version = "Cinegraph/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _err(self, msg, code=400):
        self._json({"ok": False, "error": msg}, code)

    # ---------- file serving with Range
    def _file(self, path):
        if not os.path.isfile(path):
            return self._err("not found: " + path, 404)
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.lower().endswith((".mp4", ".m4v", ".mov")):
            ctype = "video/mp4"
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                start = int(m.group(1)) if m.group(1) else 0
                end = int(m.group(2)) if m.group(2) else size - 1
                end = min(end, size - 1)
                if start > end:
                    start = 0
                length = end - start + 1
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
                self.send_header("Content-Length", str(length))
                self.end_headers()
                with open(path, "rb") as f:
                    f.seek(start)
                    left = length
                    while left > 0:
                        chunk = f.read(min(262144, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
                return
        with open(path, "rb") as f:
            body = f.read()
        self._send(200, body, ctype, {"Accept-Ranges": "bytes"})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        try:
            if p == "/" or p == "/index.html":
                return self._file(os.path.join(WEB, "index.html"))
            if p.startswith("/web/"):
                return self._file(os.path.join(WEB, os.path.basename(p)))

            if p == "/api/ping":
                return self._json({"ok": True, "ffmpeg": FFMPEG, "ffprobe": FFPROBE,
                                   "version": "1.0", "port": PORT})

            if p == "/api/projects":
                out = []
                for fn in sorted(os.listdir(PROJ)):
                    if fn.endswith(".json"):
                        j = jload(os.path.join(PROJ, fn), {})
                        if j:
                            n = len(j.get("shots", []))
                            if not n:
                                cid = j.get("id") or fn[:-5]
                                n = len(jload(os.path.join(CACHE, cid, "shots.json"), []))
                            out.append({"id": j.get("id"), "title": j.get("title"),
                                        "video": j.get("video"), "created": j.get("created", 0),
                                        "shots": n})
                out.sort(key=lambda x: -x.get("created", 0))
                return self._json({"ok": True, "items": out})

            if p == "/api/browse":
                target = unquote(q.get("path", [""])[0])
                if not target:
                    drives = []
                    for l in "CDEFGHIJKLMNOPQRSTUVWXYZ":
                        if os.path.exists(l + ":\\"):
                            drives.append(l + ":\\")
                    return self._json({"ok": True, "path": "", "dirs": drives, "files": [], "up": None})
                target = os.path.abspath(target)
                if not os.path.isdir(target):
                    return self._err("不是目录: " + target)
                dirs, files = [], []
                try:
                    for name in sorted(os.listdir(target)):
                        full = os.path.join(target, name)
                        if os.path.isdir(full):
                            if not name.startswith("."):
                                dirs.append(name)
                        elif name.lower().endswith((".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv", ".flv")):
                            files.append({"name": name, "size": os.path.getsize(full)})
                except PermissionError:
                    return self._err("无权限访问: " + target, 403)
                up = os.path.dirname(target)
                return self._json({"ok": True, "path": target, "dirs": dirs, "files": files,
                                   "up": (up if up != target else None)})

            if p == "/api/open":
                path = unquote(q.get("path", [""])[0])
                if not path or not os.path.isfile(path):
                    return self._err("找不到视频: " + path)
                cid = cid_of(path)
                pf = os.path.join(PROJ, cid + ".json")
                created = False
                if not os.path.exists(pf):
                    meta = probe(path)
                    d = os.path.join(CACHE, cid)
                    os.makedirs(d, exist_ok=True)
                    shots = jload(os.path.join(d, "shots.json"), [])
                    proj = {"id": cid, "video": path,
                            "title": os.path.splitext(os.path.basename(path))[0],
                            "created": int(time.time()), "meta": meta,
                            "shots": shots, "sections": [],
                            "tags": {"scale": ["大远景", "远景", "全景", "中景", "中近景", "近景", "特写", "大特写"],
                                     "move": ["固定", "推", "拉", "摇", "移", "跟", "升降", "手持", "斯坦尼康", "航拍"],
                                     "light": ["顺光", "侧光", "逆光", "顶光", "底光", "硬光", "柔光", "高调", "低调", "混合光"],
                                     "color": ["冷调", "暖调", "中性", "高饱和", "低饱和", "单色", "对比色"]}}
                    jdump(proj, pf)
                    created = True
                proj = jload(pf, {})
                need = ensure_analysis(path, cid, force=(not os.path.exists(os.path.join(CACHE, cid, "shots.json"))))
                return self._json({"ok": True, "id": cid, "project": proj, "analyzing": need})

            if p == "/api/project":
                cid = q.get("id", [""])[0]
                pf = os.path.join(PROJ, cid + ".json")
                if not os.path.exists(pf):
                    return self._err("项目不存在", 404)
                return self._json({"ok": True, "project": jload(pf, {})})

            if p == "/api/status":
                cid = q.get("id", [""])[0]
                d = os.path.join(CACHE, cid)
                pr = jload(os.path.join(d, "progress.json"), {"stage": "none", "pct": 0, "msg": ""})
                ready = os.path.exists(os.path.join(d, "shots.json")) and pr.get("stage") == "done"
                return self._json({"ok": True, "progress": pr, "ready": ready})

            if p == "/api/analysis":
                cid = q.get("id", [""])[0]
                d = os.path.join(CACHE, cid)
                if not os.path.exists(os.path.join(d, "shots.json")):
                    return self._err("尚未分析完成", 409)
                return self._json({"ok": True,
                                   "meta": jload(os.path.join(d, "meta.json"), {}),
                                   "shots": jload(os.path.join(d, "shots.json"), []),
                                   "strip": jload(os.path.join(d, "strip.json"), {}),
                                   "wave": jload(os.path.join(d, "wave.json"), {}),
                                   "metrics": jload(os.path.join(d, "metrics.json"), {})})

            if p == "/media":
                cid = q.get("id", [""])[0]
                pf = os.path.join(PROJ, cid + ".json")
                proj = jload(pf, {})
                if not proj:
                    return self._err("项目不存在", 404)
                return self._file(proj["video"])

            if p.startswith("/cache/"):
                parts = p.split("/")
                if len(parts) >= 4:
                    cid, fn = parts[2], parts[3]
                    if ".." in fn or "/" in fn:
                        return self._err("bad", 400)
                    return self._file(os.path.join(CACHE, cid, fn))

            return self._err("404 " + p, 404)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self._err("server error: %s" % e, 500)

    def _upload(self, u):
        q = parse_qs(u.query)
        name = unquote(q.get("name", ["video.mp4"])[0])
        base = os.path.basename(name.replace("\\", "/"))
        safe = re.sub(r'[^\w\u4e00-\u9fff.\- ()]', "_", base).strip() or "video.mp4"
        if not os.path.splitext(safe)[1]:
            safe += ".mp4"
        updir = os.path.join(DATA, "uploads")
        os.makedirs(updir, exist_ok=True)
        first = os.path.join(updir, safe)
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return self._err("空文件")

        # 同名同大小 → 复用已有副本，不再重复落盘
        if os.path.exists(first) and os.path.getsize(first) == n:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                left -= len(chunk)
            return self._json({"ok": True, "path": first, "size": n, "cached": True})

        dst = first
        stem, ext = os.path.splitext(first)
        k = 1
        while os.path.exists(dst):
            dst = "%s_%d%s" % (stem, k, ext)
            k += 1

        got = 0
        try:
            with open(dst, "wb") as f:
                while got < n:
                    chunk = self.rfile.read(min(1 << 20, n - got))
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
        except Exception as e:
            try:
                os.remove(dst)
            except Exception:
                pass
            return self._err("写入失败: %s" % e, 500)
        if got == 0 or (n and got < n):
            return self._err("上传不完整 %d/%d" % (got, n))
        return self._json({"ok": True, "path": dst, "size": got})

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/api/upload":
            try:
                return self._upload(u)
            except Exception as e:
                import traceback
                traceback.print_exc()
                return self._err("upload error: %s" % e, 500)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(body, dict):
                return self._err("body 必须是 JSON 对象")
            _id = body.get("id", "")
            if not isinstance(_id, str) or not _id:
                return self._err("id 参数错误")
            body["id"] = _id

            if p == "/api/save":
                cid = body.get("id", "")
                pf = os.path.join(PROJ, cid + ".json")
                if not cid:
                    return self._err("缺少 id")
                proj = jload(pf, {})
                proj.update({k: v for k, v in body.get("project", {}).items()})
                proj["id"] = cid
                jdump(proj, pf)
                return self._json({"ok": True, "saved": int(time.time())})

            if p == "/api/reanalyze":
                cid = body.get("id", "")
                th = float(body.get("threshold", 0.28))
                pf = os.path.join(PROJ, cid + ".json")
                proj = jload(pf, {})
                if not proj:
                    return self._err("项目不存在")
                ensure_analysis(proj["video"], cid, force=True, threshold=th)
                return self._json({"ok": True})

            if p == "/api/resync":
                cid = body.get("id", "")
                pf = os.path.join(PROJ, cid + ".json")
                proj = jload(pf, {})
                if not proj:
                    return self._err("项目不存在")
                d = os.path.join(CACHE, cid)
                auto = jload(os.path.join(d, "shots.json"), [])
                old = {round(s.get("t", 0), 2): s for s in proj.get("shots", [])}
                merged = []
                for s in auto:
                    key = round(s["t"], 2)
                    prev = old.get(key)
                    item = dict(s)
                    if prev:
                        for k in ("scale", "move", "light", "color", "sound", "func", "note", "tag"):
                            item[k] = prev.get(k, "")
                        item["locked"] = prev.get("locked", False)
                    merged.append(item)
                proj["shots"] = merged
                jdump(proj, pf)
                return self._json({"ok": True, "count": len(merged)})

            return self._err("404", 404)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self._err("server error: %s" % e, 500)


def main():
    print("=" * 56)
    print("  帧鉴 · Cinegraph")
    print("  http://127.0.0.1:%d" % PORT)
    print("  ffmpeg : %s" % FFMPEG)
    print("  ffprobe: %s" % FFPROBE)
    print("=" * 56)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")

if __name__ == "__main__":
    main()
