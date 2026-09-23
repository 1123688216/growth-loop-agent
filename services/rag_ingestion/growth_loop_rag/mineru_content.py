from __future__ import annotations

from collections import defaultdict
import re
from typing import Any, Iterable

from .mineru_client import MinerUArtifacts
from .models import DocumentNodeDraft, ExtractedDocument, ExtractedPage, NodeType


MINERU_PARSER_VERSION = "mineru-protocol-v2-adapter-v1"
SKIPPED_TYPES = {
    "page_header",
    "page_footer",
    "page_number",
    "page_aside_text",
    "aside",
    "page_footnote",
}


def _clean(value: str) -> str:
    return re.sub(r"[ \t]+\n", "\n", value.replace("\r\n", "\n").replace("\r", "\n")).strip()


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return _clean(value)
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        parts = [_text(item) for item in value]
        return _clean("\n".join(part for part in parts if part))
    if isinstance(value, dict):
        for key in (
            "content",
            "text",
            "title_content",
            "paragraph_content",
            "code_content",
            "algorithm_content",
            "math_content",
            "table_body",
            "image_caption",
            "table_caption",
            "chart_caption",
            "caption",
        ):
            if key in value:
                content = _text(value[key])
                if content:
                    return content
        parts = [_text(item) for key, item in value.items() if key not in {"bbox", "index", "page_idx", "type"}]
        return _clean("\n".join(part for part in parts if part))
    return ""


def _block_type(block: dict[str, Any]) -> str:
    return str(block.get("type") or block.get("block_type") or "paragraph").strip().lower()


def _block_text(block: dict[str, Any], block_type: str) -> str:
    keys: dict[str, tuple[str, ...]] = {
        "title": ("title_content", "content", "text"),
        "paragraph": ("paragraph_content", "content", "text"),
        "equation_interline": ("math_content", "content", "text"),
        "equation": ("math_content", "content", "text"),
        "code": ("code_content", "content", "text"),
        "algorithm": ("algorithm_content", "code_content", "content", "text"),
        "table": ("table_body", "table_caption", "content", "text"),
        "image": ("image_caption", "caption", "content", "text"),
        "chart": ("chart_caption", "caption", "content", "text"),
        "list": ("list_items", "content", "text"),
        "index": ("index_content", "content", "text"),
        "page_footnote": ("content", "text"),
    }
    for key in keys.get(block_type, ("content", "text")):
        if key in block:
            content = _text(block[key])
            if content:
                return content
    return _text(block)


def _node_type(block_type: str) -> NodeType:
    if block_type == "title":
        return "heading"
    if block_type in {"equation_interline", "equation"}:
        return "equation"
    if block_type in {"code", "algorithm"}:
        return "code"
    if block_type == "table":
        return "table"
    if block_type in {"image", "chart"}:
        return "image"
    if block_type in {"list", "index"}:
        return "list"
    if block_type in {"page_footnote", "caption"}:
        return "caption"
    return "paragraph"


def _heading_level(block: dict[str, Any]) -> int:
    nested = block.get("content") if isinstance(block.get("content"), dict) else {}
    raw = (
        block.get("level")
        or block.get("title_level")
        or block.get("heading_level")
        or nested.get("level")
        or 1
    )
    try:
        return max(1, min(6, int(raw)))
    except (TypeError, ValueError):
        return 1


def _iter_page_blocks(content_list_v2: list[Any]) -> Iterable[tuple[int, dict[str, Any]]]:
    for page_position, page in enumerate(content_list_v2):
        if isinstance(page, list):
            page_number = page_position + 1
            blocks = page
        elif isinstance(page, dict):
            raw_page = page.get("page_idx", page.get("page_index", page_position))
            try:
                page_number = int(raw_page) + 1
            except (TypeError, ValueError):
                page_number = page_position + 1
            blocks = page.get("blocks") or page.get("block_list") or page.get("content") or []
        else:
            continue
        if isinstance(blocks, dict):
            blocks = [blocks]
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            if isinstance(block, dict):
                yield page_number, block


def _find_offset(markdown: str, value: str, cursor: int) -> tuple[int, int, bool]:
    index = markdown.find(value, cursor)
    if index < 0:
        index = markdown.find(value)
    if index >= 0:
        return index, index + len(value), True
    start = min(len(markdown), max(0, cursor))
    return start, min(len(markdown), start + len(value)), False


def _metadata(block: dict[str, Any], block_type: str, exact: bool) -> dict[str, Any]:
    result: dict[str, Any] = {"mineruType": block_type, "offsetExact": exact}
    for key in ("bbox", "index", "image_path", "table_img_path", "score"):
        value = block.get(key)
        if value is not None:
            result[key] = value
    return result


def _fallback_markdown_nodes(markdown: str) -> list[DocumentNodeDraft]:
    nodes: list[DocumentNodeDraft] = []
    heading_stack: list[tuple[int, str, int]] = []
    pattern = re.compile(r"(?m)^(#{1,6})\s+(.+?)\s*$")
    cursor = 0

    def add_paragraph(start: int, end: int) -> None:
        raw = markdown[start:end]
        for match in re.finditer(r"\S(?:[\s\S]*?\S)?(?=\n\s*\n|\Z)", raw):
            text = match.group(0).strip()
            if not text:
                continue
            local_start = start + match.start() + len(match.group(0)) - len(match.group(0).lstrip())
            nodes.append(DocumentNodeDraft(
                position=len(nodes),
                parent_position=heading_stack[-1][2] if heading_stack else None,
                type="paragraph",
                text=text,
                section_path=[entry[1] for entry in heading_stack],
                char_start=local_start,
                char_end=local_start + len(text),
                metadata={"mineruType": "markdown_fallback", "offsetExact": True},
            ))

    for match in pattern.finditer(markdown):
        add_paragraph(cursor, match.start())
        level = len(match.group(1))
        title = match.group(2).strip()
        while heading_stack and heading_stack[-1][0] >= level:
            heading_stack.pop()
        node = DocumentNodeDraft(
            position=len(nodes),
            parent_position=heading_stack[-1][2] if heading_stack else None,
            type="heading",
            heading_level=level,
            text=title,
            section_path=[entry[1] for entry in heading_stack] + [title],
            char_start=match.start(2),
            char_end=match.end(2),
            metadata={"mineruType": "markdown_heading", "offsetExact": True},
        )
        nodes.append(node)
        heading_stack.append((level, title, node.position))
        cursor = match.end()
    add_paragraph(cursor, len(markdown))
    return nodes


def build_extracted_document(artifacts: MinerUArtifacts) -> ExtractedDocument:
    markdown = _clean(artifacts.markdown)
    warnings = list(artifacts.warnings)
    if not artifacts.content_list_v2:
        nodes = _fallback_markdown_nodes(markdown)
        return ExtractedDocument(
            status="ready" if markdown else "failed",
            text=markdown,
            normalized_markdown=markdown,
            nodes=nodes,
            parser_name="mineru-markdown-fallback",
            parser_version=MINERU_PARSER_VERSION,
            warnings=warnings,
            error_message="" if markdown else "MinerU 没有返回可读取的文字。",
        )

    nodes: list[DocumentNodeDraft] = []
    heading_stack: list[tuple[int, str, int]] = []
    page_text: dict[int, list[str]] = defaultdict(list)
    offset_cursor = 0
    for page_number, block in _iter_page_blocks(artifacts.content_list_v2):
        block_type = _block_type(block)
        if block_type in SKIPPED_TYPES:
            continue
        content = _block_text(block, block_type)
        if not content:
            continue
        node_type = _node_type(block_type)
        level = _heading_level(block) if node_type == "heading" else None
        if level is not None:
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            section_path = [entry[1] for entry in heading_stack] + [content]
            parent_position = heading_stack[-1][2] if heading_stack else None
        else:
            section_path = [entry[1] for entry in heading_stack]
            parent_position = heading_stack[-1][2] if heading_stack else None
        start, end, exact = _find_offset(markdown, content, offset_cursor)
        node = DocumentNodeDraft(
            position=len(nodes),
            parent_position=parent_position,
            type=node_type,
            heading_level=level,
            text=content,
            section_path=section_path,
            page_start=page_number,
            page_end=page_number,
            char_start=start,
            char_end=end,
            metadata=_metadata(block, block_type, exact),
        )
        nodes.append(node)
        offset_cursor = max(offset_cursor, end)
        page_text[page_number].append(content)
        if level is not None:
            heading_stack.append((level, content, node.position))

    if not nodes:
        warnings.append("MinerU V2 结构列表为空，已从 Markdown 回退生成节点。")
        nodes = _fallback_markdown_nodes(markdown)
    inexact = sum(1 for node in nodes if not bool(node.metadata.get("offsetExact", True)))
    if inexact:
        warnings.append(f"{inexact} 个结构节点无法在 Markdown 中精确定位，已保留 MinerU 页码与近似字符范围。")
    pages = [
        ExtractedPage(page=page, text="\n\n".join(parts))
        for page, parts in sorted(page_text.items())
    ]
    return ExtractedDocument(
        status="ready",
        text=markdown,
        normalized_markdown=markdown,
        pages=pages,
        nodes=nodes,
        parser_name="mineru-content-list-v2",
        parser_version=MINERU_PARSER_VERSION,
        warnings=warnings,
    )
