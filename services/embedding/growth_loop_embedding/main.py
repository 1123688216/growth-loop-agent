from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from . import __version__
from .models import (
    EmbeddingRequest,
    EmbeddingResponse,
    HealthResponse,
    ModelHealth,
    OpenAIEmbeddingItem,
    OpenAIEmbeddingResponse,
    OpenAIEmbeddingUsage,
    OpenAIModelCard,
    OpenAIModelList,
)
from .registry import EmbeddingRegistry
from .settings import Settings


settings = Settings.from_env()
registry = EmbeddingRegistry(settings)
logger = logging.getLogger(__name__)
app = FastAPI(
    title="Growth Loop Embedding",
    version=__version__,
    docs_url="/docs",
    redoc_url=None,
)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    try:
        device = registry.resolved_device()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    return HealthResponse(
        service_version=__version__,
        device=device,
        loaded_model=registry.loaded_alias,
        models=[
            ModelHealth(
                alias=spec.alias,
                model=spec.model,
                revision=spec.revision,
                path=str(spec.path),
                available=spec.path.is_dir(),
            )
            for spec in settings.models.values()
        ],
    )


@app.get("/v1/models", response_model=OpenAIModelList)
async def list_models() -> OpenAIModelList:
    """OpenAI-compatible model discovery endpoint used by RAGFlow."""

    return OpenAIModelList(
        data=[
            OpenAIModelCard(
                id=spec.alias,
                owned_by="local",
            )
            for spec in settings.models.values()
            if spec.path.is_dir()
        ]
    )


@app.post(
    "/v1/embeddings",
    response_model=EmbeddingResponse | OpenAIEmbeddingResponse,
)
async def embeddings(
    request: EmbeddingRequest,
) -> EmbeddingResponse | OpenAIEmbeddingResponse:
    """Serve both the original API and OpenAI-compatible embeddings.

    Original Growth Loop request:
        {"model":"bge-m3", "texts":["..."], "input_type":"document"}
        -> returns the original EmbeddingResponse with `vectors`.

    OpenAI/RAGFlow request:
        {"model":"bge-m3", "input":["..."]}
        -> returns OpenAI-compatible `data[].embedding`.
    """

    if request.encoding_format != "float":
        raise HTTPException(
            status_code=400,
            detail="encoding_format='base64' is not supported; use 'float'",
        )

    texts = request.resolved_texts()

    try:
        result = await asyncio.to_thread(
            registry.embed,
            request.model,
            request.input_type,
            texts,
            request.normalize,
        )
    except KeyError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (FileNotFoundError, RuntimeError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    # Keep existing project callers fully backward compatible.
    if not request.is_openai_request:
        return result

    # OpenAI's `dimensions` option is model-dependent. This service exposes the
    # model's native dimension only; reject a conflicting requested dimension.
    if request.dimensions is not None and request.dimensions != result.dimension:
        raise HTTPException(
            status_code=400,
            detail=(
                f"model '{request.model}' has fixed dimension {result.dimension}; "
                f"requested dimensions={request.dimensions}"
            ),
        )

    return OpenAIEmbeddingResponse(
        data=[
            OpenAIEmbeddingItem(
                index=index,
                embedding=vector,
            )
            for index, vector in enumerate(result.vectors)
        ],
        model=request.model,
        usage=OpenAIEmbeddingUsage(
            prompt_tokens=result.input_tokens,
            total_tokens=result.input_tokens,
        ),
    )


@app.exception_handler(Exception)
async def unexpected_error(_request, error: Exception) -> JSONResponse:
    logger.exception("Unexpected embedding service error", exc_info=error)
    return JSONResponse(
        status_code=500,
        content={"detail": "Embedding service failed."},
    )
