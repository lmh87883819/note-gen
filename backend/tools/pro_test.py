from __future__ import annotations

import asyncio
import os
import time
import json
import sys
from pathlib import Path
from typing import Any, Optional

import httpx
from agno.tools import tool

try:
    from ..data_types import ToolArtifactType, ToolResult
except ImportError:  # pragma: no cover
    sys.path.append(str(Path(__file__).resolve().parents[2]))
    from backend.data_types import ToolArtifactType, ToolResult


def _draw_base_url() -> str:
    return (os.getenv("GRSAI_DRAW_BASE_URL") or "https://grsai.dakka.com.cn").rstrip("/")


def _draw_api_key() -> str:
    key = 'sk-eeb0b6be3a1b48fb8e5ee0573b06a3f4'
    if not key:
        raise ValueError("Missing GRSAI_DRAW_API_KEY (or OPENAI_API_KEY)")
    return key


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_draw_api_key()}",
        "Content-Type": "application/json",
        "oss-id": "694e4f19025dd9004f423aeb",
    }


async def _post_json(client: httpx.AsyncClient, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    resp = await client.post(_draw_base_url() + path, headers=_headers(), json=payload)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and "code" in data and data.get("code") not in (0, "0", None):
        raise ValueError(f"Grsai draw error: code={data.get('code')}, msg={data.get('msg')}")
    return data


async def _generate_image_impl(
    prompt: str,
    model: str = "nano-banana-fast",
    aspectRatio: str = "auto",
    imageSize: str = "1K",
    urls: Optional[list[str]] = None,
) -> dict[str, Any]:
    """
    Grsai nano-banana 绘画（submit + result 轮询）。
    - submit: POST /v1/draw/nano-banana (webHook='-1')
    - result: POST /v1/draw/result
    """

    timeout_s = float(os.getenv("GRSAI_DRAW_TIMEOUT_S", "180"))
    poll_interval_s = float(os.getenv("GRSAI_DRAW_POLL_INTERVAL_S", "1.0"))

    submit_payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "aspectRatio": aspectRatio or "auto",
        "webHook": "-1",
        "shutProgress": True,
    }
    if urls:
        submit_payload["urls"] = urls
    if imageSize:
        submit_payload["imageSize"] = imageSize

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        submit = await _post_json(client, "/v1/draw/nano-banana", submit_payload)
        draw_id = (submit.get("data") or {}).get("id") if isinstance(submit, dict) else None
        if not draw_id:
            raise ValueError(f"Grsai draw submit returned no id: {submit}")

        deadline = time.monotonic() + timeout_s
        last: dict[str, Any] = {"id": draw_id, "status": "running", "progress": 0}
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError(f"Grsai draw timeout after {timeout_s}s, last={last}")

            result = await _post_json(client, "/v1/draw/result", {"id": draw_id})
            data = result.get("data") if isinstance(result, dict) else None
            if not isinstance(data, dict):
                raise ValueError(f"Grsai draw result invalid: {result}")

            last = data
            status = str(data.get("status") or "")
            if status == "succeeded":
                results = data.get("results") or []
                if not results or not isinstance(results, list) or not isinstance(results[0], dict):
                    raise ValueError(f"Grsai draw succeeded but missing results: {data}")
                url = str(results[0].get("url") or "")
                content = str(results[0].get("content") or "")
                if not url:
                    raise ValueError(f"Grsai draw succeeded but missing url: {data}")
                result = ToolResult(
                    id=draw_id,
                    status="succeeded",
                    progress=100,
                    results=[
                        {
                            "type": ToolArtifactType.IMAGE,
                            "url": url,
                            "content": content,
                        }
                    ],
                    meta={
                        "provider": "grsai",
                        "model": model,
                        "aspectRatio": aspectRatio,
                        "imageSize": imageSize,
                    },
                    raw=data,
                )
                return result.model_dump(mode="json")

            if status == "failed":
                raise RuntimeError(
                    f"Grsai draw failed: reason={data.get('failure_reason') or ''} error={data.get('error') or ''}"
                )

            await asyncio.sleep(poll_interval_s)


generate_image = tool(
    name="generate_image",
    description="Generate an image via Grsai nano-banana draw API. Returns ToolResult.",
)(_generate_image_impl)


async def _cli_main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Test Grsai nano-banana draw API")
    parser.add_argument("--prompt", default="生成鸟瞰图场景图", help="Text prompt")
    parser.add_argument("--model", default="nano-banana-fast")
    parser.add_argument("--aspectRatio", default="auto")
    parser.add_argument("--imageSize", default="1K")
    parser.add_argument("--url", action="append", default=['https://eva-1313581156.cos.ap-nanjing.myqcloud.com/1.jpg'], help="Reference image URL (repeatable)")
    args = parser.parse_args()

    try:
        result = await _generate_image_impl(
            prompt=args.prompt,
            model=args.model,
            aspectRatio=args.aspectRatio,
            imageSize=args.imageSize,
            urls=args.url or None,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_cli_main()))
