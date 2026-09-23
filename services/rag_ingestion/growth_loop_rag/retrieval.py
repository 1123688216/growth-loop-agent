"""LlamaIndex adapters. No business database access and no answer generation."""
from __future__ import annotations

import asyncio
import math
import os
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from llama_index.core import VectorStoreIndex
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.schema import QueryBundle, TextNode
from pydantic import BaseModel, Field, PrivateAttr, model_validator

router = APIRouter()
ModelAlias = Literal["bge-m3", "qwen3-embedding-0.6b"]


class EncodeRequest(BaseModel):
    model: ModelAlias
    input_type: Literal["document", "query"]
    texts: list[str] = Field(min_length=1, max_length=128)
    normalize: Literal[True] = True


class LocalEmbedding(BaseEmbedding):
    """Pass text through unchanged; the GPU service owns query instructions."""

    model_name: str = "qwen3-embedding-0.6b"
    _responses: list[dict] = PrivateAttr(default_factory=list)

    def _encode(self, texts: list[str], kind: str) -> list[list[float]]:
        url = os.environ.get("EMBEDDING_SERVICE_URL", "http://127.0.0.1:8020").rstrip("/")
        timeout = float(os.environ.get("EMBEDDING_TIMEOUT_MS", "600000")) / 1000
        # Never use the web proxy for the local GPU service.
        with httpx.Client(timeout=timeout, trust_env=False) as client:
            response = client.post(url + "/v1/embeddings", json={
                "model": self.model_name, "input_type": kind,
                "texts": texts, "normalize": True,
            })
            response.raise_for_status()
            data = response.json()
        vectors = data.get("vectors", [])
        if data.get("model_alias") != self.model_name or data.get("normalized") is not True:
            raise ValueError("Embedding model/normalization mismatch")
        if len(vectors) != len(texts) or any(
            len(vector) != 1024 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in vector)
            or abs(math.sqrt(sum(v * v for v in vector)) - 1) > 0.01
            for vector in vectors
        ):
            raise ValueError("Invalid embedding vectors")
        self._responses.append(data)
        return vectors

    def _get_query_embedding(self, query: str) -> list[float]:
        return self._encode([query], "query")[0]

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return await asyncio.to_thread(self._get_query_embedding, query)

    def _get_text_embedding(self, text: str) -> list[float]:
        return self._encode([text], "document")[0]

    def _get_text_embeddings(self, texts: list[str]) -> list[list[float]]:
        return self._encode(texts, "document")

    def encode_response(self, request: EncodeRequest) -> dict:
        if request.input_type == "document":
            vectors = self.get_text_embedding_batch(request.texts)
        else:
            vectors = [self.get_query_embedding(text) for text in request.texts]
        first = self._responses[0]
        contract = (first["model"], first["revision"], first["dimension"])
        if any((r["model"], r["revision"], r["dimension"]) != contract for r in self._responses):
            raise ValueError("Embedding profile changed during batch")
        return {**first, "vectors": vectors,
                "input_tokens": sum(r["input_tokens"] for r in self._responses),
                "timing": {key: sum(r["timing"][key] for r in self._responses)
                           for key in ("model_load_ms", "tokenize_ms", "encode_ms")}}


class VectorItem(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    vector: list[float] = Field(min_length=1024, max_length=1024)


class RankRequest(BaseModel):
    model: ModelAlias
    query_vector: list[float] = Field(min_length=1024, max_length=1024)
    candidates: list[VectorItem] = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def check_vectors(self):
        if len({item.id for item in self.candidates}) != len(self.candidates):
            raise ValueError("Duplicate chunk IDs")
        for vector in [self.query_vector, *(item.vector for item in self.candidates)]:
            if any(not math.isfinite(v) for v in vector) or abs(math.sqrt(sum(v * v for v in vector)) - 1) > 0.01:
                raise ValueError("Vectors must be finite and normalized")
        return self


def rank(request: RankRequest) -> dict:
    # Only the already-authorized bounded batch crosses the process boundary.
    # Precomputed embeddings prevent accidental re-encoding or cloud defaults.
    nodes = [TextNode(id_=item.id, text=item.id, embedding=item.vector) for item in request.candidates]
    index = VectorStoreIndex(nodes, embed_model=LocalEmbedding(model_name=request.model))
    results = index.as_retriever(similarity_top_k=len(nodes)).retrieve(
        QueryBundle(query_str="", embedding=request.query_vector)
    )
    return {"engine": "llamaindex", "items": [
        {"id": item.node.node_id, "score": item.score} for item in results
    ]}


@router.post("/v1/embeddings")
def encode(request: EncodeRequest):
    try:
        return LocalEmbedding(model_name=request.model, embed_batch_size=128).encode_response(request)
    except httpx.HTTPError as error:
        raise HTTPException(502, "LlamaIndex cannot reach the configured embedding service") from error
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(502, "LlamaIndex embedding response contract invalid") from error


@router.post("/v1/retrieve/vectors")
def retrieve_vectors(request: RankRequest):
    return rank(request)
