from __future__ import annotations

from dataclasses import dataclass
import asyncio
import io
import json
from pathlib import PurePosixPath
import time
from typing import Any
import zipfile

import httpx

from .settings import Settings


MAX_ZIP_ENTRIES = 5_000
MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
MAX_COMPRESSION_RATIO = 1_000


class MinerUError(RuntimeError):
    pass


@dataclass(frozen=True)
class MinerUArtifacts:
    markdown: str
    content_list_v2: list[Any] | None
    content_list: list[dict[str, Any]] | None
    warnings: list[str]


def _url(base_url: str, value: str | None, fallback: str) -> str:
    if not value:
        return f"{base_url}{fallback}"
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return f"{base_url}/{value.lstrip('/')}"


def _response_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except (ValueError, UnicodeDecodeError):
        return response.text.strip() or response.reason_phrase
    if isinstance(payload, dict):
        for key in ("detail", "error", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return json.dumps(payload, ensure_ascii=False)


def _require_success(response: httpx.Response, operation: str) -> None:
    if response.is_success:
        return
    raise MinerUError(f"MinerU {operation} failed ({response.status_code}): {_response_detail(response)}")


def _safe_zip_entries(payload: bytes) -> dict[str, bytes]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as error:
        raise MinerUError("MinerU result is not a valid ZIP archive.") from error

    infos = archive.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        raise MinerUError("MinerU result contains too many ZIP entries.")
    total = 0
    result: dict[str, bytes] = {}
    for info in infos:
        path = PurePosixPath(info.filename.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts:
            raise MinerUError("MinerU result contains an unsafe ZIP path.")
        if info.is_dir():
            continue
        total += info.file_size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise MinerUError("MinerU result is too large after decompression.")
        if info.file_size >= 20 * 1024 * 1024 and info.file_size > max(1, info.compress_size) * MAX_COMPRESSION_RATIO:
            raise MinerUError("MinerU result has a suspicious compression ratio.")
        result[path.as_posix()] = archive.read(info)
    return result


def parse_result_zip(payload: bytes) -> MinerUArtifacts:
    files = _safe_zip_entries(payload)
    markdown_names = sorted(name for name in files if name.lower().endswith(".md"))
    v2_names = sorted(name for name in files if name.lower().endswith("content_list_v2.json"))
    v1_names = sorted(
        name for name in files
        if name.lower().endswith("content_list.json") and not name.lower().endswith("content_list_v2.json")
    )
    if not markdown_names:
        raise MinerUError("MinerU result does not contain Markdown output.")

    markdown = files[markdown_names[0]].decode("utf-8", errors="replace").strip()
    if not markdown:
        raise MinerUError("MinerU returned empty Markdown output.")

    def load_json(names: list[str], *, v2: bool = False) -> list[Any] | None:
        if not names:
            return None
        try:
            value = json.loads(files[names[0]].decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise MinerUError(f"MinerU returned invalid JSON in {names[0]}.") from error
        valid_v1 = isinstance(value, list) and all(isinstance(item, dict) for item in value)
        valid_v2 = isinstance(value, list) and all(
            (isinstance(page, list) and all(isinstance(block, dict) for block in page))
            or isinstance(page, dict)
            for page in value
        )
        if not (valid_v2 if v2 else valid_v1):
            raise MinerUError(f"MinerU returned an unexpected structure in {names[0]}.")
        return value

    warnings: list[str] = []
    content_v2 = load_json(v2_names, v2=True)
    content_v1 = load_json(v1_names)
    if content_v2 is None:
        warnings.append("MinerU 未返回 content_list_v2.json，结构节点将从 Markdown 回退生成。")
    return MinerUArtifacts(markdown, content_v2, content_v1, warnings)


class MinerUClient:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        if not settings.mineru_api_url:
            raise MinerUError("MINERU_API_URL is not configured.")
        self.settings = settings
        self._transport = transport

    async def health(self) -> tuple[bool, int | None]:
        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                timeout=10,
                follow_redirects=True,
            ) as client:
                response = await client.get(f"{self.settings.mineru_api_url}/health")
                _require_success(response, "health check")
                data = response.json()
                protocol = data.get("protocol_version") if isinstance(data, dict) else None
                protocol = int(protocol) if isinstance(protocol, (int, str)) and str(protocol).isdigit() else None
                status = data.get("status") if isinstance(data, dict) else None
                return status == "healthy" and protocol == 2, protocol
        except (httpx.HTTPError, ValueError, TypeError):
            return False, None

    async def parse(self, filename: str, content: bytes) -> MinerUArtifacts:
        started = time.monotonic()
        async with httpx.AsyncClient(
            transport=self._transport,
            timeout=httpx.Timeout(connect=10, read=600, write=300, pool=30),
            follow_redirects=True,
        ) as client:
            health = await client.get(f"{self.settings.mineru_api_url}/health")
            _require_success(health, "health check")
            health_data = health.json()
            protocol = health_data.get("protocol_version") if isinstance(health_data, dict) else None
            if not isinstance(health_data, dict) or health_data.get("status") != "healthy" or protocol != 2:
                raise MinerUError("MinerU protocol v2 is required by this adapter.")

            data = {
                "lang_list": "ch",
                "backend": self.settings.mineru_backend,
                "effort": self.settings.mineru_effort,
                "parse_method": "auto",
                "formula_enable": "true",
                "table_enable": "true",
                "image_analysis": "true",
                "return_md": "true",
                "return_middle_json": "false",
                "return_model_output": "false",
                "return_content_list": "true",
                "return_images": "false",
                "response_format_zip": "true",
                "return_original_file": "false",
                "client_side_output_generation": "false",
                "start_page_id": "0",
                "end_page_id": "99999",
            }
            create = await client.post(
                f"{self.settings.mineru_api_url}/tasks",
                data=data,
                files=[("files", (filename, content, "application/octet-stream"))],
            )
            _require_success(create, "task submission")
            created = create.json()
            if not isinstance(created, dict) or not isinstance(created.get("task_id"), str):
                raise MinerUError("MinerU did not return a task_id.")
            task_id = created["task_id"]
            status_url = _url(
                self.settings.mineru_api_url,
                created.get("status_url"),
                f"/tasks/{task_id}",
            )
            result_url = _url(
                self.settings.mineru_api_url,
                created.get("result_url"),
                f"/tasks/{task_id}/result",
            )

            while True:
                if time.monotonic() - started > self.settings.mineru_timeout_seconds:
                    raise MinerUError("MinerU parsing timed out.")
                status_response = await client.get(status_url)
                _require_success(status_response, "task status query")
                status_data = status_response.json()
                if not isinstance(status_data, dict):
                    raise MinerUError("MinerU returned an invalid task status.")
                status = str(status_data.get("status", "")).lower()
                if status in {"completed", "success", "succeeded"}:
                    result_url = _url(
                        self.settings.mineru_api_url,
                        status_data.get("result_url"),
                        f"/tasks/{task_id}/result",
                    )
                    break
                if status in {"failed", "error", "cancelled", "canceled"}:
                    detail = status_data.get("error") or status_data.get("message") or status
                    raise MinerUError(f"MinerU parsing failed: {detail}")
                if status not in {"pending", "queued", "processing", "running"}:
                    raise MinerUError(f"MinerU returned an unknown task status: {status or 'empty'}")
                await asyncio.sleep(self.settings.mineru_poll_interval_ms / 1000)

            result = await client.get(result_url)
            _require_success(result, "result download")
            return parse_result_zip(result.content)
