from __future__ import annotations

from dataclasses import dataclass
import gc
from threading import RLock
from time import perf_counter_ns

import numpy as np

from .models import EmbeddingResponse, TimingResponse
from .settings import ModelSpec, Settings


def _elapsed_ms(start_ns: int) -> float:
    return round((perf_counter_ns() - start_ns) / 1_000_000, 3)


@dataclass
class LoadedModel:
    spec: ModelSpec
    tokenizer: object
    model: object
    device: str
    dtype: str


class EmbeddingRegistry:
    """Lazy single-model cache so two 1024-d models do not occupy VRAM together."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._loaded: LoadedModel | None = None
        self._lock = RLock()

    @property
    def loaded_alias(self) -> str | None:
        return self._loaded.spec.alias if self._loaded else None

    def resolved_device(self) -> str:
        import torch

        configured = self.settings.device
        if configured == "auto":
            return "cuda" if torch.cuda.is_available() else "cpu"
        if configured == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("EMBEDDING_DEVICE=cuda but CUDA is unavailable")
        if configured not in {"cpu", "cuda"}:
            raise RuntimeError("EMBEDDING_DEVICE must be auto, cpu, or cuda")
        return configured

    def _release_loaded(self) -> None:
        if not self._loaded:
            return
        import torch

        self._loaded = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def _load(self, spec: ModelSpec) -> tuple[LoadedModel, float]:
        if self._loaded and self._loaded.spec.alias == spec.alias:
            return self._loaded, 0.0
        if not spec.path.is_dir():
            raise FileNotFoundError(f"model directory does not exist: {spec.path}")

        from transformers import AutoModel, AutoTokenizer
        import torch

        self._release_loaded()
        device = self.resolved_device()
        dtype = torch.float16 if device == "cuda" else torch.float32
        started = perf_counter_ns()
        tokenizer = AutoTokenizer.from_pretrained(spec.path, local_files_only=True)
        tokenizer.padding_side = "left" if spec.pooling == "last_token" else "right"
        model = AutoModel.from_pretrained(spec.path, local_files_only=True, dtype=dtype)
        model.eval()
        model.to(device)
        if device == "cuda":
            torch.cuda.synchronize()
        load_ms = _elapsed_ms(started)
        self._loaded = LoadedModel(
            spec=spec,
            tokenizer=tokenizer,
            model=model,
            device=device,
            dtype=str(dtype).removeprefix("torch."),
        )
        return self._loaded, load_ms

    def embed(
        self,
        alias: str,
        input_type: str,
        texts: list[str],
        normalize: bool,
    ) -> EmbeddingResponse:
        if alias not in self.settings.models:
            raise KeyError(f"unsupported model alias: {alias}")
        if len(texts) > self.settings.max_batch_texts:
            raise ValueError(f"batch exceeds {self.settings.max_batch_texts} texts")
        if any(len(text) > self.settings.max_text_chars for text in texts):
            raise ValueError(f"one or more texts exceed {self.settings.max_text_chars} characters")

        with self._lock:
            import torch
            import torch.nn.functional as functional

            loaded, model_load_ms = self._load(self.settings.models[alias])
            prepared = [
                f"{loaded.spec.query_instruction}{text}" if input_type == "query" and loaded.spec.query_instruction else text
                for text in texts
            ]

            tokenize_started = perf_counter_ns()
            encoded = loaded.tokenizer(
                prepared,
                padding=True,
                truncation=True,
                max_length=self.settings.max_length,
                return_tensors="pt",
            )
            input_tokens = int(encoded["attention_mask"].sum().item())
            tokenize_ms = _elapsed_ms(tokenize_started)

            encoded = {name: tensor.to(loaded.device) for name, tensor in encoded.items()}
            if loaded.device == "cuda":
                torch.cuda.synchronize()
            encode_started = perf_counter_ns()
            with torch.inference_mode():
                output = loaded.model(**encoded)
                if loaded.spec.pooling == "last_token":
                    embeddings = output.last_hidden_state[:, -1]
                else:
                    embeddings = output.last_hidden_state[:, 0]
                if normalize:
                    embeddings = functional.normalize(embeddings.float(), p=2, dim=1)
                else:
                    embeddings = embeddings.float()
            if loaded.device == "cuda":
                torch.cuda.synchronize()
            encode_ms = _elapsed_ms(encode_started)
            vectors = embeddings.detach().cpu().numpy().astype(np.float32, copy=False)
            if not np.isfinite(vectors).all():
                raise RuntimeError("embedding model returned non-finite values")

            return EmbeddingResponse(
                model_alias=loaded.spec.alias,
                model=loaded.spec.model,
                revision=loaded.spec.revision,
                dimension=int(vectors.shape[1]),
                device=loaded.device,
                dtype=loaded.dtype,
                normalized=normalize,
                input_tokens=input_tokens,
                vectors=vectors.tolist(),
                timing=TimingResponse(
                    model_load_ms=model_load_ms,
                    tokenize_ms=tokenize_ms,
                    encode_ms=encode_ms,
                ),
            )
