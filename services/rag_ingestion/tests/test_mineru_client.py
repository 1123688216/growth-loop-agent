import io
import json
import zipfile

import httpx
import pytest

from growth_loop_rag.mineru_client import MinerUClient, MinerUError, parse_result_zip
from growth_loop_rag.settings import Settings


def zip_payload(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    return output.getvalue()


def test_parse_result_zip_prefers_v2_structure():
    payload = zip_payload({
        "result/document.md": "# 标题\n\n正文".encode(),
        "result/document_content_list_v2.json": json.dumps([[{"type": "paragraph", "content": {"paragraph_content": []}}]]).encode(),
    })
    artifacts = parse_result_zip(payload)
    assert artifacts.markdown.startswith("# 标题")
    assert artifacts.content_list_v2 == [[{"type": "paragraph", "content": {"paragraph_content": []}}]]


def test_parse_result_zip_rejects_path_traversal():
    payload = zip_payload({"../document.md": b"unsafe"})
    with pytest.raises(MinerUError, match="unsafe ZIP path"):
        parse_result_zip(payload)


@pytest.mark.asyncio
async def test_protocol_v2_async_task_flow():
    payload = zip_payload({
        "document.md": b"# title\n\nbody",
        "document_content_list_v2.json": b"[]",
    })
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.url.path == "/health":
            return httpx.Response(200, json={
                "status": "healthy",
                "protocol_version": 2,
                "max_concurrent_requests": 1,
                "processing_window_size": 1,
            })
        if request.url.path == "/tasks" and request.method == "POST":
            body = request.read()
            assert b'name="files"' in body
            assert b'name="return_content_list"' in body
            assert b'name="response_format_zip"' in body
            assert b'name="effort"' in body
            assert b"medium" in body
            return httpx.Response(202, json={
                "task_id": "task-1",
                "status_url": "/tasks/task-1",
                "result_url": "/tasks/task-1/result",
            })
        if request.url.path == "/tasks/task-1":
            return httpx.Response(200, json={"status": "completed"})
        if request.url.path == "/tasks/task-1/result":
            return httpx.Response(200, content=payload, headers={"content-type": "application/zip"})
        return httpx.Response(404)

    settings = Settings(
        mineru_api_url="http://mineru.local",
        mineru_backend="pipeline",
        mineru_effort="medium",
        mineru_poll_interval_ms=100,
        mineru_timeout_seconds=30,
        parent_chunk_tokens=2048,
        child_chunk_tokens=512,
        chunk_overlap_tokens=20,
    )
    artifacts = await MinerUClient(settings, httpx.MockTransport(handler)).parse("paper.pdf", b"%PDF-1.7")
    assert artifacts.markdown.startswith("# title")
    assert calls == [
        "GET /health",
        "POST /tasks",
        "GET /tasks/task-1",
        "GET /tasks/task-1/result",
    ]
