from __future__ import annotations

from pathlib import Path
from threading import Lock


class LocalTranscriber:
    def __init__(self, model_dir: str, device: str = "cpu",
                 compute_type: str = "int8", language: str = "zh"):
        self.model_dir = Path(model_dir).expanduser().resolve()
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self._model = None
        self._load_lock = Lock()

    def available(self) -> bool:
        required = ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt")
        return all((self.model_dir / name).is_file() for name in required)

    def load(self):
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is None:
                if not self.available():
                    raise RuntimeError(f"模型文件不完整: {self.model_dir}")
                from faster_whisper import WhisperModel
                self._model = WhisperModel(
                    str(self.model_dir), device=self.device,
                    compute_type=self.compute_type)
        return self._model

    def transcribe(self, media_path: str) -> str:
        model = self.load()
        language = None if self.language.lower() in ("", "auto") else self.language
        segments, _ = model.transcribe(
            media_path, beam_size=5, vad_filter=True, language=language)
        return "".join(segment.text for segment in segments).strip()
