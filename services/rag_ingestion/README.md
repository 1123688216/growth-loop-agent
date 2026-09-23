# RAG ingestion service

This service isolates document parsing and parent-child chunking from the Next.js application.

## LlamaIndex encoding and vector retrieval (2026-09-15)

`POST /v1/embeddings` uses a LlamaIndex BaseEmbedding adapter to call the existing GPU service. Set `EMBEDDING_SERVICE_URL` on this Python process (default `http://127.0.0.1:8020`), and optionally `EMBEDDING_TIMEOUT_MS` (default 600000). Text is passed unchanged; query instructions are applied only by the GPU service. No cloud model is selected implicitly.

`POST /v1/retrieve/vectors` accepts at most 128 pre-authorized normalized 1024-dimensional vectors and one query vector, and returns ranked chunk IDs through VectorStoreIndex/VectorIndexRetriever. It has no business database or filesystem access. SQLite remains the persistent vector store in the Node business layer; bounded in-memory indexes are rebuilt per batch. This is a local demo adapter, not an ANN index or independently persistent vector database. Node validates returned IDs and merges batches before evidence processing.

Restart this process and Next.js after upgrading. Keep RAG and GPU services bound to loopback; do not expose the inference endpoints publicly. The existing startup script will reuse an already-running process, so stop the old RAG process before starting the updated code. No user files were reprocessed during implementation. The chunk viewer continues using the existing database API and now exposes the prefixed document text sent for encoding.

- MinerU protocol v2 converts PDF/DOCX into Markdown plus `content_list_v2.json`.
- LlamaIndex `HierarchicalNodeParser` creates immutable Parent/Child chunks.
- The response is mapped to the existing Growth Loop Schema V9 contract.
- TXT and pasted text use Markdown + LlamaIndex directly.

MinerU models are intentionally not installed by this package. Run an official MinerU API separately and set `MINERU_API_URL`.

## Local development

Use Python 3.12 on Windows:

```powershell
uv sync --extra dev --python D:\Python3.12\python.exe
$env:MINERU_API_URL = "http://127.0.0.1:8000"
.\.venv\Scripts\python.exe -m uvicorn growth_loop_rag.main:app --host 127.0.0.1 --port 8010
```

The Next.js application connects through `RAG_INGESTION_URL=http://127.0.0.1:8010`. If the variable is absent or the service fails and `RAG_INGESTION_REQUIRED=false`, the existing TypeScript parser remains the fallback.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MINERU_API_URL` | empty | Official `mineru-api` base URL |
| `MINERU_BACKEND` | `pipeline` | MinerU backend; CPU-compatible default |
| `MINERU_EFFORT` | `medium` | MinerU hybrid effort; API accepts `medium` or `high` |
| `MINERU_TIMEOUT_SECONDS` | `900` | Maximum async task duration |
| `RAG_PARENT_CHUNK_TOKENS` | `2048` | LlamaIndex Parent size |
| `RAG_CHILD_CHUNK_TOKENS` | `512` | LlamaIndex Child size |
| `RAG_CHUNK_OVERLAP_TOKENS` | `20` | LlamaIndex default sibling overlap |

These token values are configuration, not a claimed optimum. They must later be tuned against the project's fixed retrieval benchmark.
