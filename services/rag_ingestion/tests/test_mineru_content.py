from growth_loop_rag.mineru_client import MinerUArtifacts
from growth_loop_rag.mineru_content import build_extracted_document


def test_content_list_v2_preserves_structure_and_filters_running_elements():
    markdown = """# RAG 设计

父子分块先检索子片段，再回读父片段。

```python
print("hello")
```

| 方法 | 用途 |
| --- | --- |
| Parent | 上下文 |
"""
    content = [[
        {"type": "page_header", "content": {"page_header_content": [{"type": "text", "content": "内部资料"}]}},
        {"type": "title", "content": {"title_content": [{"type": "text", "content": "RAG 设计"}], "level": 1}, "bbox": [0, 0, 10, 10]},
        {"type": "paragraph", "content": {"paragraph_content": [{"type": "text", "content": "父子分块先检索子片段，再回读父片段。"}]}},
        {"type": "code", "content": {"code_content": [{"type": "text", "content": 'print("hello")'}]}},
        {"type": "table", "content": {"table_body": "| 方法 | 用途 |\n| --- | --- |\n| Parent | 上下文 |"}},
        {"type": "page_number", "content": {"page_number_content": [{"type": "text", "content": "1"}]}},
    ]]
    extracted = build_extracted_document(MinerUArtifacts(markdown, content, None, []))

    assert extracted.status == "ready"
    assert [node.type for node in extracted.nodes] == ["heading", "paragraph", "code", "table"]
    assert all(node.page_start == 1 for node in extracted.nodes)
    assert extracted.nodes[1].section_path == ["RAG 设计"]
    assert extracted.nodes[1].parent_position == extracted.nodes[0].position
    assert "内部资料" not in extracted.pages[0].text
    assert extracted.parser_name == "mineru-content-list-v2"


def test_missing_v2_falls_back_to_markdown_nodes():
    markdown = "# 第一章\n\n这是正文。\n\n## 小节\n\n这是第二段。"
    extracted = build_extracted_document(MinerUArtifacts(markdown, None, None, ["fallback"] ))

    assert extracted.status == "ready"
    assert [node.type for node in extracted.nodes] == ["heading", "paragraph", "heading", "paragraph"]
    assert extracted.nodes[-1].section_path == ["第一章", "小节"]
    assert extracted.warnings == ["fallback"]
