# Local embedding service

This service exposes the two pinned local models through one bounded API. It
loads only one model at a time, uses CUDA when available, returns normalized
1024-dimensional vectors, and reports model-load/tokenization/encoding timing.

From `services/embedding`, run:

```powershell
$env:EMBEDDING_DEVICE = "auto"
G:\MinerU\.venv\Scripts\python.exe -m uvicorn growth_loop_embedding.main:app --host 127.0.0.1 --port 8020
```

The defaults expect these local directories:

- `G:\Embedding\bge-m3`
- `G:\Embedding\qwen3-embedding-0.6b`

Override them with `EMBEDDING_BGE_M3_PATH` and `EMBEDDING_QWEN3_PATH`.

