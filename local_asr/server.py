from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from threading import Event, Lock, Thread
from urllib.parse import urlparse

ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
CONFIG_EXAMPLE_PATH = Path(getattr(sys, "_MEIPASS", ROOT)) / "config.example.json"
if not CONFIG_PATH.exists() and CONFIG_EXAMPLE_PATH.is_file():
    shutil.copyfile(CONFIG_EXAMPLE_PATH, CONFIG_PATH)
CONFIG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from transcriber import LocalTranscriber

logging.basicConfig(level=logging.INFO, format="[Local ASR] %(message)s")
log = logging.getLogger("dcxzs_local_asr")

app = FastAPI(title="DF Local ASR", docs_url=None, redoc_url=None)
ALLOWED_ORIGIN = r"^(https://([a-z0-9-]+\.)?douyin\.com|chrome-extension://[a-z]+)$"
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=ALLOWED_ORIGIN,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def allow_local_network_preflight(request, call_next):
    response = await call_next(request)
    origin = request.headers.get("origin", "")
    if (request.headers.get("access-control-request-private-network") == "true"
            and re.fullmatch(ALLOWED_ORIGIN, origin)):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

configured_model_dir = Path(str(CONFIG.get("model_dir", "./models/faster-whisper-medium"))).expanduser()
if not configured_model_dir.is_absolute():
    configured_model_dir = (ROOT / configured_model_dir).resolve()

transcriber = LocalTranscriber(
    str(configured_model_dir),
    device=CONFIG.get("device", "cpu"),
    compute_type=CONFIG.get("compute_type", "int8"),
    language=CONFIG.get("language", "zh"),
)
transcribe_lock = Lock()
model_download = {
    "status": "idle", "error": "", "downloaded_bytes": 0,
    "total_bytes": int(CONFIG.get("expected_model_bytes", 1530575439)),
    "percent": 0.0, "speed_bytes_per_sec": 0, "eta_seconds": None,
}

ALLOWED_VIDEO_SUFFIXES = (
    ".douyin.com", ".douyinvod.com", ".bytecdn.cn", ".byteimg.com",
    ".ibytedtos.com", ".pstatp.com", ".snssdk.com", ".zjcdn.com",
)


class TranscribeRequest(BaseModel):
    video_url: str
    video_id: str = ""


class ClipRequest(BaseModel):
    video_url: str
    video_id: str = ""
    start_time: float
    end_time: float


class AISettings(BaseModel):
    base_url: str
    model: str
    api_key: str = ""
    temperature: float = 0.7


class ModelPathRequest(BaseModel):
    model_dir: str


def _required_model_files(path: Path) -> bool:
    required = ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt")
    return all((path / name).is_file() for name in required)


def _activate_model_directory(value: str) -> Path:
    candidate = Path(value.strip().strip('"')).expanduser().resolve()
    nested = candidate / "faster-whisper-medium"
    if not _required_model_files(candidate) and _required_model_files(nested):
        candidate = nested
    if not _required_model_files(candidate):
        raise ValueError("所选目录不是完整的 faster-whisper medium 模型目录")
    transcriber.model_dir = candidate
    transcriber._model = None
    CONFIG["model_dir"] = str(candidate)
    _save_config()
    return candidate


@app.get("/", response_class=HTMLResponse)
async def status_page():
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DF 本地伴侣</title><style>
body{margin:0;background:#f3f4f6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}.wrap{max-width:720px;margin:40px auto;padding:0 18px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.06)}h1{font-size:24px;margin:0 0 6px}.sub{color:#6b7280}.row{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid #eee}.value{text-align:right;word-break:break-all}.ok{color:#15803d;font-weight:700}.warn{color:#b45309;font-weight:700}button{border:0;border-radius:8px;background:#2563eb;color:#fff;padding:10px 16px;font-weight:700;cursor:pointer;margin:14px 8px 0 0}.ghost{background:#e5e7eb;color:#374151}.hint{margin-top:20px;padding:12px;background:#eff6ff;color:#1e40af;border-radius:8px;line-height:1.7}
</style></head><body><main class="wrap"><section class="card"><h1>DF 本地伴侣</h1><p class="sub">本页面可以打开，说明本地服务运行正常。</p><div class="row"><span>服务状态</span><span id="service" class="value ok">运行正常</span></div><div class="row"><span>转写模型</span><span id="model" class="value">检测中</span></div><div class="row"><span>模型目录</span><span id="dir" class="value">—</span></div><button id="download">下载转写模型</button><button id="select" class="ghost">使用已有模型目录</button><button class="ghost" onclick="refresh()">重新检测</button><div class="hint">视频截取不需要下载转写模型。使用转文字、AI 分析或视频截取时，请保持黑色窗口运行。</div></section></main><script>
const $=id=>document.getElementById(id);async function refresh(){try{const h=await(await fetch('/health',{cache:'no-store'})).json();$('service').textContent='运行正常 · '+h.version;$('dir').textContent=h.model_dir;$('model').textContent=h.model_ready?'已安装，可以转文字':((h.model_download||{}).status==='downloading'?'正在下载 '+(h.model_download.percent||0)+'%':'尚未下载');$('model').className='value '+(h.model_ready?'ok':'warn');if((h.model_download||{}).status==='downloading')setTimeout(refresh,1000)}catch(e){$('service').textContent='连接异常：'+e.message}}$('download').onclick=async()=>{if(confirm('模型约1.43GB，是否下载？')){await fetch('/api/model/download',{method:'POST'});refresh()}};$('select').onclick=async()=>{const r=await fetch('/api/model/select-folder',{method:'POST'}),d=await r.json();if(!r.ok)alert(d.detail||'选择失败');refresh()};refresh();
</script></body></html>"""


@app.post("/api/model/path")
async def set_model_path(body: ModelPathRequest):
    try:
        selected = _activate_model_directory(body.model_dir)
    except (OSError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"status": "done", "model_dir": str(selected), "model_ready": True}


@app.post("/api/model/select-folder")
async def select_model_folder():
    if os.name != "nt":
        raise HTTPException(400, "当前文件夹选择器仅支持 Windows")
    script = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d=New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$d.Description='请选择 faster-whisper medium 模型文件夹';"
        "$d.ShowNewFolderButton=$false;"
        "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){"
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$d.SelectedPath}"
    )
    result = await asyncio.to_thread(
        subprocess.run,
        ["powershell.exe", "-NoProfile", "-STA", "-Command", script],
        capture_output=True, text=True, encoding="utf-8", timeout=300,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    selected_value = result.stdout.strip()
    if not selected_value:
        return {"cancelled": True}
    try:
        selected = _activate_model_directory(selected_value)
    except (OSError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"status": "done", "model_dir": str(selected), "model_ready": True, "cancelled": False}


def _validate_video_url(value: str) -> str:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        raise ValueError("视频地址无效")
    if not any(host == suffix[1:] or host.endswith(suffix)
               for suffix in ALLOWED_VIDEO_SUFFIXES):
        raise ValueError(f"不支持的视频域名: {host}")
    try:
        for result in socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM):
            address = result[4][0]
            if address.startswith(("127.", "10.", "192.168.", "169.254.")):
                raise ValueError("视频地址不能指向本机或内网")
    except socket.gaierror as exc:
        raise ValueError("视频域名无法解析") from exc
    return value


def _download_video(url: str, destination: Path) -> None:
    max_bytes = max(1, int(CONFIG.get("max_download_mb", 1024))) * 1024 * 1024
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
        "Referer": "https://www.douyin.com/",
    }
    downloaded = 0
    with requests.get(url, headers=headers, stream=True, timeout=(15, 120),
                      allow_redirects=True) as response:
        response.raise_for_status()
        _validate_video_url(response.url)
        content_type = response.headers.get("Content-Type", "").lower()
        if "text/html" in content_type:
            raise RuntimeError("视频地址返回了网页内容")
        declared_size = int(response.headers.get("Content-Length", "0") or 0)
        if declared_size > max_bytes:
            raise RuntimeError("视频超过本地服务允许的最大大小")
        with destination.open("wb") as output:
            for chunk in response.iter_content(chunk_size=512 * 1024):
                if not chunk:
                    continue
                downloaded += len(chunk)
                if downloaded > max_bytes:
                    raise RuntimeError("视频超过本地服务允许的最大大小")
                output.write(chunk)
    if downloaded == 0:
        raise RuntimeError("下载到的视频为空")


def _run_transcription(video_url: str) -> str:
    with transcribe_lock:
        task_dir = Path(tempfile.mkdtemp(prefix="dcxzs_local_asr_"))
        try:
            video_path = task_dir / "video.mp4"
            _download_video(video_url, video_path)
            return transcriber.transcribe(str(video_path))
        finally:
            shutil.rmtree(task_dir, ignore_errors=True)


def _clip_video(source: Path, destination: Path, start_time: float,
                end_time: float) -> None:
    """Decode and re-encode a precise clip using the bundled PyAV libraries."""
    import av

    source_container = av.open(str(source))
    try:
        video_input = next((stream for stream in source_container.streams
                            if stream.type == "video"), None)
        audio_input = next((stream for stream in source_container.streams
                            if stream.type == "audio"), None)
        if video_input is None:
            raise RuntimeError("下载内容中没有视频轨道")

        duration = (float(source_container.duration) / av.time_base
                    if source_container.duration else None)
        if duration is not None and start_time >= duration:
            raise RuntimeError(f"开始时间超过视频时长（{duration:.1f}秒）")

        output = av.open(str(destination), mode="w")
        try:
            rate = video_input.average_rate or 25
            video_output = output.add_stream("libx264", rate=rate)
            video_output.width = video_input.codec_context.width
            video_output.height = video_input.codec_context.height
            video_output.pix_fmt = "yuv420p"
            video_output.options = {"preset": "veryfast", "crf": "23"}

            audio_output = None
            audio_resampler = None
            if audio_input is not None:
                audio_rate = audio_input.codec_context.sample_rate or 44100
                audio_layout = audio_input.codec_context.layout
                layout_name = audio_layout.name if audio_layout else "stereo"
                audio_output = output.add_stream("aac", rate=audio_rate)
                audio_output.layout = layout_name
                audio_resampler = av.AudioResampler(
                    format="fltp", layout=layout_name, rate=audio_rate)

            source_container.seek(
                int(start_time * av.time_base), backward=True, any_frame=False)
            wrote_video = False
            video_finished = False
            audio_finished = audio_input is None
            stream_indexes = {video_input.index}
            if audio_input is not None:
                stream_indexes.add(audio_input.index)

            for packet in source_container.demux():
                if packet.stream.index not in stream_indexes:
                    continue
                for frame in packet.decode():
                    frame_time = frame.time
                    if frame_time is None:
                        continue
                    frame_time = float(frame_time)
                    if frame_time < start_time:
                        continue
                    if frame_time >= end_time:
                        if packet.stream.type == "video":
                            video_finished = True
                        elif packet.stream.type == "audio":
                            audio_finished = True
                        if video_finished and audio_finished:
                            break
                        continue

                    relative_time = frame_time - start_time
                    if packet.stream.type == "video":
                        frame.pts = round(relative_time / float(frame.time_base))
                        for encoded in video_output.encode(frame):
                            output.mux(encoded)
                        wrote_video = True
                    elif audio_output is not None and audio_resampler is not None:
                        frame.pts = round(relative_time / float(frame.time_base))
                        for resampled in audio_resampler.resample(frame):
                            for encoded in audio_output.encode(resampled):
                                output.mux(encoded)
                if video_finished and audio_finished:
                    break

            if not wrote_video:
                raise RuntimeError("指定时间段内没有可用视频画面")
            for encoded in video_output.encode(None):
                output.mux(encoded)
            if audio_output is not None:
                for encoded in audio_output.encode(None):
                    output.mux(encoded)
        finally:
            output.close()
    finally:
        source_container.close()


def _run_clip(video_url: str, start_time: float,
              end_time: float) -> tuple[Path, Path]:
    task_dir = Path(tempfile.mkdtemp(prefix="dcxzs_video_clip_"))
    source = task_dir / "source.mp4"
    destination = task_dir / "clip.mp4"
    try:
        _download_video(video_url, source)
        _clip_video(source, destination, start_time, end_time)
        if not destination.is_file() or destination.stat().st_size == 0:
            raise RuntimeError("裁剪后的视频文件为空")
        source.unlink(missing_ok=True)
        return destination, task_dir
    except Exception:
        shutil.rmtree(task_dir, ignore_errors=True)
        raise


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "df-local-asr",
        "version": "1.3.0",
        "model_ready": transcriber.available(),
        "model_dir": str(transcriber.model_dir),
        "model_name": "faster-whisper-medium",
        "device": transcriber.device,
        "compute_type": transcriber.compute_type,
        "model_download": model_download,
    }


def _save_config() -> None:
    CONFIG_PATH.write_text(json.dumps(CONFIG, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _directory_download_bytes(path: Path) -> int:
    """Count model payload and active partial files without counting cache metadata twice."""
    total = 0
    if not path.exists():
        return 0
    for file_path in path.rglob("*"):
        if not file_path.is_file():
            continue
        parts = {part.lower() for part in file_path.parts}
        if ".cache" in parts and not file_path.name.endswith((".incomplete", ".part")):
            continue
        try:
            total += file_path.stat().st_size
        except OSError:
            pass
    return total


def _monitor_model_download(stop_event: Event, started_at: float) -> None:
    previous_bytes = _directory_download_bytes(transcriber.model_dir)
    previous_time = time.monotonic()
    smoothed_speed = 0.0
    while not stop_event.wait(0.5):
        current_time = time.monotonic()
        current_bytes = _directory_download_bytes(transcriber.model_dir)
        elapsed = max(0.001, current_time - previous_time)
        instant_speed = max(0, current_bytes - previous_bytes) / elapsed
        if instant_speed > 0:
            smoothed_speed = instant_speed if smoothed_speed == 0 else (smoothed_speed * 0.7 + instant_speed * 0.3)
        total_bytes = max(1, int(model_download.get("total_bytes") or 1))
        progress_bytes = min(current_bytes, total_bytes)
        remaining = max(0, total_bytes - progress_bytes)
        eta = round(remaining / smoothed_speed) if smoothed_speed > 1 else None
        model_download.update(
            downloaded_bytes=progress_bytes,
            percent=round(progress_bytes * 100 / total_bytes, 1),
            speed_bytes_per_sec=round(smoothed_speed),
            eta_seconds=eta,
            elapsed_seconds=round(current_time - started_at),
        )
        previous_bytes = current_bytes
        previous_time = current_time


def _download_model() -> None:
    started_at = time.monotonic()
    model_download.update(
        status="preparing", error="", downloaded_bytes=0, percent=0.0,
        speed_bytes_per_sec=0, eta_seconds=None, elapsed_seconds=0,
    )
    stop_event = Event()
    monitor = None
    try:
        endpoint = str(CONFIG.get("hf_endpoint", "")).strip()
        if endpoint:
            os.environ["HF_ENDPOINT"] = endpoint
        from huggingface_hub import HfApi, snapshot_download
        try:
            info = HfApi(endpoint=endpoint or None).model_info(
                repo_id=CONFIG.get("model_repo", "Systran/faster-whisper-medium"),
                files_metadata=True,
            )
            remote_total = sum(int(getattr(item, "size", 0) or 0) for item in (info.siblings or []))
            if remote_total > 0:
                model_download["total_bytes"] = remote_total
        except Exception as exc:
            log.warning("无法读取模型总大小，使用内置预计值：%s", exc)
        model_download["status"] = "downloading"
        monitor = Thread(target=_monitor_model_download, args=(stop_event, started_at), daemon=True)
        monitor.start()
        snapshot_download(
            repo_id=CONFIG.get("model_repo", "Systran/faster-whisper-medium"),
            local_dir=str(transcriber.model_dir),
        )
        if not transcriber.available():
            raise RuntimeError("模型下载结束，但必要文件不完整")
        total_bytes = max(1, int(model_download.get("total_bytes") or 1))
        model_download.update(
            status="done", error="", downloaded_bytes=total_bytes,
            percent=100.0, speed_bytes_per_sec=0, eta_seconds=0,
            elapsed_seconds=round(time.monotonic() - started_at),
        )
    except Exception as exc:
        model_download.update(status="failed", error=str(exc))
    finally:
        stop_event.set()
        if monitor:
            monitor.join(timeout=1)


@app.post("/api/model/download")
async def start_model_download():
    if transcriber.available():
        return {"status": "done"}
    if model_download["status"] in ("preparing", "downloading"):
        return model_download
    asyncio.create_task(asyncio.to_thread(_download_model))
    return {"status": "starting"}


@app.get("/api/ai/settings")
async def get_ai_settings():
    key = str(CONFIG.get("ai_api_key", ""))
    return {
        "base_url": CONFIG.get("ai_base_url", "https://api.deepseek.com/v1"),
        "model": CONFIG.get("ai_model", "deepseek-chat"),
        "temperature": CONFIG.get("ai_temperature", 0.7),
        "configured": bool(key),
        "api_key_masked": (key[:3] + "***" + key[-3:]) if len(key) > 7 else ("***" if key else ""),
    }


@app.post("/api/ai/settings")
async def save_ai_settings(body: AISettings):
    if not body.base_url.strip() or not body.model.strip():
        raise HTTPException(400, "API 地址和模型名称不能为空")
    CONFIG["ai_base_url"] = body.base_url.strip().rstrip("/")
    CONFIG["ai_model"] = body.model.strip()
    CONFIG["ai_temperature"] = max(0, min(2, body.temperature))
    if body.api_key.strip():
        CONFIG["ai_api_key"] = body.api_key.strip()
    _save_config()
    return {"status": "ok", "configured": bool(CONFIG.get("ai_api_key"))}


def _parse_json_content(content: str) -> dict:
    content = content.strip()
    if content.startswith("```"):
        content = content.strip("`").removeprefix("json").strip()
    start, end = content.find("{"), content.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("大模型未返回 JSON")
    return json.loads(content[start:end + 1])


def _ai_chat(system_prompt: str, user_prompt: str) -> dict:
    api_key = str(CONFIG.get("ai_api_key", "")).strip()
    if not api_key:
        raise RuntimeError("尚未配置大模型 API Key，请点击扩展图标进行配置")
    url = str(CONFIG["ai_base_url"]).rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": CONFIG["ai_model"],
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
        "temperature": CONFIG.get("ai_temperature", 0.7),
        "response_format": {"type": "json_object"},
    }
    response = requests.post(url, headers=headers, json=payload, timeout=180)
    if response.status_code == 400:
        # Some OpenAI-compatible providers do not implement response_format.
        payload.pop("response_format", None)
        response = requests.post(url, headers=headers, json=payload, timeout=180)
    response.raise_for_status()
    return _parse_json_content(response.json()["choices"][0]["message"]["content"])


@app.post("/api/ai/test")
async def test_ai():
    try:
        result = await asyncio.to_thread(_ai_chat, "只输出JSON。", "返回 {\"ok\": true}")
        return {"status": "ok", "result": result}
    except Exception as exc:
        raise HTTPException(502, f"大模型连接失败: {exc}") from exc


@app.post("/api/ai/script-analysis")
async def script_analysis(body: dict):
    text = str(body.get("asr_text", "")).strip()
    if not text:
        raise HTTPException(400, "转写文稿为空")
    stats = body.get("stats") or {}
    system = "你是专业短视频文案拆解师。分析开头钩子、论述结构、结尾引导、爆款归因、可复用技巧和一句话总结。引用原文证据，严格输出JSON。"
    user = f"视频数据：{json.dumps(stats, ensure_ascii=False)}\n完整文案：\n{text}\n请输出结构化JSON。"
    try:
        return {"status": "ok", "result": await asyncio.to_thread(_ai_chat, system, user)}
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/ai/comment-insight")
async def comment_insight(body: dict):
    comments = str(body.get("comments_text", "")).strip()
    if not comments:
        raise HTTPException(400, "评论数据为空")
    title = str(body.get("video_title", ""))
    system = "你是短视频内容策略分析师。清洗评论，提炼认知困惑、实践踩坑、情感焦虑、渴望诉求、争议质疑，并生成选题。严格输出JSON。"
    user = f"视频：{title}\n评论：\n{comments}\n输出sampling_info、pain_points、topics、summary字段。"
    try:
        return {"status": "ok", "result": await asyncio.to_thread(_ai_chat, system, user)}
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/transcribe")
async def transcribe(body: TranscribeRequest):
    try:
        video_url = _validate_video_url(body.video_url.strip())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not transcriber.available():
        raise HTTPException(503, f"本地模型未就绪: {transcriber.model_dir}")
    try:
        text = await asyncio.to_thread(_run_transcription, video_url)
    except requests.RequestException as exc:
        log.exception("视频下载失败")
        raise HTTPException(502, f"视频下载失败: {exc}") from exc
    except ModuleNotFoundError as exc:
        log.exception("本地转写依赖缺失")
        raise HTTPException(
            503,
            f"本地转写组件缺失: {exc.name}。请安装或重新下载完整的 Windows 伴侣包，然后重启本地伴侣。",
        ) from exc
    except Exception as exc:
        log.exception("本地转写失败")
        raise HTTPException(500, f"本地转写失败: {exc}") from exc
    return {
        "status": "succeeded" if text else "no_speech",
        "text": text,
        "video_id": body.video_id,
    }


@app.post("/api/video/clip")
async def clip_video(body: ClipRequest):
    if body.start_time < 0:
        raise HTTPException(400, "开始时间不能小于0秒")
    if body.end_time <= body.start_time:
        raise HTTPException(400, "结束时间必须大于开始时间")
    if body.end_time - body.start_time > 300:
        raise HTTPException(400, "单次最多截取5分钟")
    if body.end_time > 7200:
        raise HTTPException(400, "结束时间不能超过2小时")
    try:
        video_url = _validate_video_url(body.video_url.strip())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    try:
        destination, task_dir = await asyncio.to_thread(
            _run_clip, video_url, body.start_time, body.end_time)
    except requests.RequestException as exc:
        log.exception("裁剪视频下载失败")
        raise HTTPException(502, f"视频下载失败: {exc}") from exc
    except Exception as exc:
        log.exception("视频裁剪失败")
        raise HTTPException(500, f"视频裁剪失败: {exc}") from exc

    safe_id = "".join(ch for ch in body.video_id if ch.isalnum() or ch in "-_")[:40]
    filename = f"{safe_id or 'video'}_{body.start_time:g}-{body.end_time:g}s.mp4"
    return FileResponse(
        str(destination), media_type="video/mp4", filename=filename,
        background=BackgroundTask(shutil.rmtree, task_dir, ignore_errors=True),
    )
