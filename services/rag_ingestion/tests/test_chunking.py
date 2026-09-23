from growth_loop_rag.chunking import build_chunk_set
from growth_loop_rag.mineru_client import MinerUArtifacts
from growth_loop_rag.mineru_content import build_extracted_document
from growth_loop_rag.settings import Settings


def settings() -> Settings:
    return Settings(
        mineru_api_url="",
        mineru_backend="pipeline",
        mineru_effort="medium",
        mineru_poll_interval_ms=100,
        mineru_timeout_seconds=60,
        parent_chunk_tokens=256,
        child_chunk_tokens=64,
        chunk_overlap_tokens=8,
    )


def test_hierarchical_chunks_keep_children_inside_parent():
    paragraphs = [f"第 {index} 段介绍父子检索。检索子片段后回读父片段，从而保留完整上下文和可追溯来源。" for index in range(60)]
    markdown = "# 检索设计\n\n" + "\n\n".join(paragraphs)
    blocks = [{"type": "title", "level": 1, "title_content": "检索设计"}]
    blocks.extend({"type": "paragraph", "paragraph_content": text} for text in paragraphs)
    extracted = build_extracted_document(MinerUArtifacts(markdown, [{"page_idx": 0, "blocks": blocks}], None, []))

    result = build_chunk_set(extracted, settings())

    assert result.strategy == "llamaindex-hierarchical-parent-child"
    assert len(result.parents) >= 2
    assert len(result.chunks) > len(result.parents)
    for child in result.chunks:
        parent = result.parents[child.parent_position]
        assert child.content in parent.content
        assert parent.char_start <= child.char_start <= child.char_end <= parent.char_end
        assert child.section_path == ["检索设计"]
        assert child.boundary_reason["method"] == "llamaindex-hierarchical"
