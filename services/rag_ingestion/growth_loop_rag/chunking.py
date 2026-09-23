from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from llama_index.core import Document
from llama_index.core.node_parser import HierarchicalNodeParser, get_root_nodes
from llama_index.core.schema import BaseNode, MetadataMode
from llama_index.core.utils import get_tokenizer

from .models import (
    DocumentNodeDraft,
    ExtractedDocument,
    SourceChunkDraft,
    SourceChunkSetDraft,
    SourceParentChunkDraft,
)
from .settings import Settings


LLAMAINDEX_CHUNKER_VERSION = "llama-index-core-0.14.24-hierarchical-v1"


@dataclass(frozen=True)
class Section:
    index: int
    heading: str
    path: list[str]
    content: str
    page_start: int | None
    page_end: int | None
    char_start: int
    char_end: int
    node_start: int | None
    node_end: int | None


def _min_optional(values: list[int | None]) -> int | None:
    present = [value for value in values if value is not None]
    return min(present) if present else None


def _max_optional(values: list[int | None]) -> int | None:
    present = [value for value in values if value is not None]
    return max(present) if present else None


def _render_node(node: DocumentNodeDraft) -> str:
    if node.type == "code":
        return f"```\n{node.text}\n```"
    if node.type == "equation":
        return f"$$\n{node.text}\n$$"
    return node.text


def _sections(document: ExtractedDocument) -> list[Section]:
    content_nodes = [node for node in document.nodes if node.type not in {"heading", "title"} and node.text.strip()]
    if not content_nodes:
        return [Section(
            index=0,
            heading="",
            path=[],
            content=document.normalized_markdown,
            page_start=None,
            page_end=None,
            char_start=0,
            char_end=len(document.normalized_markdown),
            node_start=None,
            node_end=None,
        )]

    groups: list[list[DocumentNodeDraft]] = []
    for node in content_nodes:
        if not groups or groups[-1][0].section_path != node.section_path:
            groups.append([node])
        else:
            groups[-1].append(node)
    sections: list[Section] = []
    for index, nodes in enumerate(groups):
        path = list(nodes[0].section_path)
        sections.append(Section(
            index=index,
            heading=path[-1] if path else "",
            path=path,
            content="\n\n".join(_render_node(node) for node in nodes),
            page_start=_min_optional([node.page_start for node in nodes]),
            page_end=_max_optional([node.page_end for node in nodes]),
            char_start=min(node.char_start for node in nodes),
            char_end=max(node.char_end for node in nodes),
            node_start=min(node.position for node in nodes),
            node_end=max(node.position for node in nodes),
        ))
    return sections


def _metadata(section: Section) -> dict[str, Any]:
    return {
        "section_index": section.index,
        "heading": section.heading,
        "section_path": json.dumps(section.path, ensure_ascii=False),
        "page_start": section.page_start if section.page_start is not None else -1,
        "page_end": section.page_end if section.page_end is not None else -1,
        "char_start": section.char_start,
        "char_end": section.char_end,
        "node_start": section.node_start if section.node_start is not None else -1,
        "node_end": section.node_end if section.node_end is not None else -1,
    }


def _integer(metadata: dict[str, Any], key: str) -> int | None:
    value = metadata.get(key, -1)
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _path(metadata: dict[str, Any]) -> list[str]:
    value = metadata.get("section_path", "[]")
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except json.JSONDecodeError:
        return []
    return [str(item) for item in parsed] if isinstance(parsed, list) else []


def _content(node: BaseNode) -> str:
    return node.get_content(metadata_mode=MetadataMode.NONE).strip()


def _token_count(content: str) -> int:
    return max(1, len(get_tokenizer()(content)))


def _source_span(
    node: BaseNode,
    metadata: dict[str, Any],
    content: str,
    *,
    ancestor_offset: int = 0,
) -> tuple[int, int]:
    base = _integer(metadata, "char_start") or 0
    local_start = getattr(node, "start_char_idx", None)
    local_end = getattr(node, "end_char_idx", None)
    if isinstance(local_start, int) and isinstance(local_end, int) and local_end >= local_start:
        return base + ancestor_offset + local_start, base + ancestor_offset + local_end
    return base, max(base, (_integer(metadata, "char_end") or base + len(content)))


def build_chunk_set(document: ExtractedDocument, settings: Settings) -> SourceChunkSetDraft:
    if document.status != "ready" or not document.normalized_markdown.strip():
        raise ValueError("Only ready documents with text can be chunked.")
    sections = _sections(document)
    documents = [
        Document(
            text=section.content,
            metadata=_metadata(section),
            excluded_embed_metadata_keys=list(_metadata(section).keys()),
            excluded_llm_metadata_keys=list(_metadata(section).keys()),
        )
        for section in sections
        if section.content.strip()
    ]
    parser = HierarchicalNodeParser.from_defaults(
        chunk_sizes=[settings.parent_chunk_tokens, settings.child_chunk_tokens],
        chunk_overlap=settings.chunk_overlap_tokens,
        include_metadata=True,
        include_prev_next_rel=False,
    )
    all_nodes = parser.get_nodes_from_documents(documents, show_progress=False)
    node_by_id = {node.node_id: node for node in all_nodes}
    root_nodes = get_root_nodes(all_nodes)
    root_nodes.sort(key=lambda node: (
        int(node.metadata.get("section_index", 0)),
        getattr(node, "start_char_idx", 0) or 0,
    ))

    parents: list[SourceParentChunkDraft] = []
    chunks: list[SourceChunkDraft] = []
    warnings: list[str] = []
    for root in root_nodes:
        root_content = _content(root)
        if not root_content:
            continue
        metadata = dict(root.metadata)
        section_path = _path(metadata)
        context_prefix = " > ".join(section_path)
        parent_content = f"{context_prefix}\n\n{root_content}" if context_prefix else root_content
        parent_start, parent_end = _source_span(root, metadata, root_content)
        parent_position = len(parents)
        parents.append(SourceParentChunkDraft(
            position=parent_position,
            heading=str(metadata.get("heading", "")),
            section_path=section_path,
            content=parent_content,
            page_start=_integer(metadata, "page_start"),
            page_end=_integer(metadata, "page_end"),
            char_start=parent_start,
            char_end=parent_end,
            token_estimate=_token_count(parent_content),
        ))

        child_nodes = [node_by_id[related.node_id] for related in (root.child_nodes or []) if related.node_id in node_by_id]
        if not child_nodes:
            child_nodes = [root]
            warnings.append(f"父片段 {parent_position} 未产生更小节点，Child 复用 Parent 原文。")
        child_nodes.sort(key=lambda node: getattr(node, "start_char_idx", 0) or 0)
        root_local_start = getattr(root, "start_char_idx", 0)
        root_local_start = root_local_start if isinstance(root_local_start, int) else 0
        for child in child_nodes:
            child_content = _content(child)
            if not child_content:
                continue
            if child_content not in root_content:
                raise ValueError("LlamaIndex produced a child that is not contained by its parent.")
            char_start, char_end = _source_span(
                child,
                metadata,
                child_content,
                ancestor_offset=0 if child is root else root_local_start,
            )
            chunks.append(SourceChunkDraft(
                position=len(chunks),
                parent_position=parent_position,
                heading=str(metadata.get("heading", "")),
                section_path=section_path,
                context_prefix=context_prefix,
                content=child_content,
                page_start=_integer(metadata, "page_start"),
                page_end=_integer(metadata, "page_end"),
                char_start=char_start,
                char_end=char_end,
                token_estimate=_token_count(child_content),
                node_start_position=_integer(metadata, "node_start"),
                node_end_position=_integer(metadata, "node_end"),
                boundary_reason={
                    "method": "llamaindex-hierarchical",
                    "parser": "HierarchicalNodeParser",
                    "parentNodeId": root.node_id,
                    "childNodeId": child.node_id,
                    "overlapTokens": settings.chunk_overlap_tokens,
                },
            ))

    if not parents or not chunks:
        raise ValueError("LlamaIndex did not produce a usable parent-child chunk set.")
    return SourceChunkSetDraft(
        strategy="llamaindex-hierarchical-parent-child",
        strategy_version=LLAMAINDEX_CHUNKER_VERSION,
        config={
            "parser": "HierarchicalNodeParser",
            "chunkSizes": [settings.parent_chunk_tokens, settings.child_chunk_tokens],
            "chunkOverlapTokens": settings.chunk_overlap_tokens,
            "retrievalUnit": "child",
            "contextUnit": "parent",
            "sectionIsolation": True,
        },
        warnings=warnings,
        parents=parents,
        chunks=chunks,
    )
