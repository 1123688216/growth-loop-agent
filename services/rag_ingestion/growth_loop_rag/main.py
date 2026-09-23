from __future__ import annotations

import asyncio
from importlib.metadata import PackageNotFoundError, version
import logging

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from . import __version__
from .chunking import build_chunk_set
from .mineru_client import MinerUArtifacts, MinerUClient, MinerUError
from .mineru_content import build_extracted_document
from .models import HealthResponse, IngestionResponse
from .settings import Settings
from .retrieval import router as retrieval_router


app = FastAPI(
    title="Growth Loop RAG Ingestion",
    version=__version__,
    docs_url="/docs",
    redoc_url=None,
)
logger = logging.getLogger(__name__)
app.include_router(retrieval_router)


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "unknown"


def _assert_file(kind: str, filename: str, content: bytes) -> None:
    if not content:
        raise HTTPException(status_code=422, detail="上传文件为空。")
    normalized = kind.strip().lower()
    if normalized not in {"text", "txt", "pdf", "docx"}:
        raise HTTPException(status_code=415, detail=f"暂不支持 {kind or filename}。")
    if normalized == "pdf" and not content.startswith(b"%PDF-"):
        raise HTTPException(status_code=422, detail="文件扩展名是 PDF，但文件头无效。")
    if normalized == "docx" and not content.startswith(b"PK"):
        raise HTTPException(status_code=422, detail="文件扩展名是 DOCX，但不是有效的 Office ZIP 文档。")


@app.get("/health", response_model=HealthResponse, response_model_by_alias=True)
async def health() -> HealthResponse:
    settings = Settings.from_env()
    healthy: bool | None = None
    protocol: int | None = None
    if settings.mineru_api_url:
        healthy, protocol = await MinerUClient(settings).health()
    return HealthResponse(
        service_version=__version__,
        llama_index_version=_package_version("llama-index-core"),
        mineru_configured=bool(settings.mineru_api_url),
        mineru_healthy=healthy,
        mineru_protocol_version=protocol,
    )


@app.post("/v1/ingest", response_model=IngestionResponse, response_model_by_alias=True)
async def ingest(
    file: UploadFile = File(...),
    kind: str = Form(...),
) -> IngestionResponse:
    content = await file.read()
    filename = file.filename or "source"
    normalized_kind = kind.strip().lower()
    _assert_file(normalized_kind, filename, content)
    settings = Settings.from_env()

    try:
        if normalized_kind in {"text", "txt"}:
            try:
                markdown = content.decode("utf-8")
            except UnicodeDecodeError:
                markdown = content.decode("gb18030")
            artifacts = MinerUArtifacts(markdown=markdown, content_list_v2=None, content_list=None, warnings=[])
            engine = "markdown+llamaindex"
        else:
            if not settings.mineru_api_url:
                raise HTTPException(
                    status_code=503,
                    detail="PDF/DOCX 的成熟解析路径需要先配置 MINERU_API_URL。",
                )
            artifacts = await MinerUClient(settings).parse(filename, content)
            engine = "mineru+llamaindex"
        extracted = build_extracted_document(artifacts)
        if extracted.status != "ready":
            raise HTTPException(status_code=422, detail=extracted.error_message or "资料没有可切片的文字。")
        chunk_set = await asyncio.to_thread(build_chunk_set, extracted, settings)
        return IngestionResponse(extracted=extracted, chunk_set=chunk_set, engine=engine)
    except HTTPException:
        raise
    except UnicodeError as error:
        raise HTTPException(status_code=422, detail="文本编码无法识别，请转换为 UTF-8 或 GB18030。") from error
    except MinerUError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.exception_handler(Exception)
async def unexpected_error(_request, error: Exception) -> JSONResponse:
    logger.exception("Unexpected RAG ingestion error", exc_info=error)
    return JSONResponse(status_code=500, content={"detail": "RAG ingestion failed."})
