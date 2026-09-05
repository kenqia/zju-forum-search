from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from .config import settings
from .models import Reply, TopicSummary


class CC98Error(Exception):
    def __init__(self, message: str, *, kind: str = "network", status_code: int | None = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code


class CC98Client(Protocol):
    async def validate_token(self, token: str) -> None: ...
    async def search_topics(self, token: str, query: str) -> list[TopicSummary]: ...
    async def get_replies(self, token: str, topic_id: str, *, page: int = 1, page_size: int = 100) -> tuple[list[Reply], bool]: ...


@dataclass
class HttpCC98Client:
    api_base: str = settings.cc98_api_base
    timeout: float = settings.cc98_timeout_seconds

    async def _request(self, token: str, method: str, path: str, **kwargs: Any) -> Any:
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        try:
            async with httpx.AsyncClient(
                base_url=self.api_base,
                timeout=self.timeout,
                trust_env=settings.cc98_trust_env,
            ) as client:
                response = await client.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise CC98Error("CC98 网络请求失败", kind="network") from exc
        if response.status_code in (401, 403):
            raise CC98Error("CC98 会话无效或无权限", kind="auth", status_code=response.status_code)
        if response.status_code == 429:
            raise CC98Error("CC98 请求过于频繁", kind="rate_limit", status_code=429)
        if response.status_code >= 400:
            raise CC98Error("CC98 服务返回错误", kind="service", status_code=response.status_code)
        try:
            return response.json()
        except ValueError as exc:
            raise CC98Error("CC98 返回了无法解析的数据", kind="service") from exc

    async def validate_token(self, token: str) -> None:
        await self._request(token, "GET", "/user/profile")

    async def search_topics(self, token: str, query: str) -> list[TopicSummary]:
        data = await self._request(token, "GET", settings.cc98_topic_search_path, params={"keyword": query})
        items = data.get("data", data) if isinstance(data, dict) else data
        if not isinstance(items, list):
            items = items.get("items", []) if isinstance(items, dict) else []
        return [_topic_from_json(item) for item in items if isinstance(item, dict)]

    async def get_replies(self, token: str, topic_id: str, *, page: int = 1, page_size: int = 100) -> tuple[list[Reply], bool]:
        data = await self._request(token, "GET", f"/topic/{topic_id}/post", params={"page": page, "pageSize": page_size})
        raw = data.get("data", data) if isinstance(data, dict) else data
        if isinstance(raw, dict):
            items = raw.get("items", raw.get("posts", []))
            has_more = bool(raw.get("hasMore", raw.get("has_more", len(items) >= page_size)))
        else:
            items, has_more = raw if isinstance(raw, list) else [], False
        return [_reply_from_json(item) for item in items if isinstance(item, dict)], has_more


def _topic_from_json(item: dict[str, Any]) -> TopicSummary:
    topic_id = str(item.get("id", item.get("topicId", item.get("topic_id", ""))))
    url = item.get("url") or item.get("link") or f"https://www.cc98.org/topic/{topic_id}"
    return TopicSummary(id=topic_id, title=str(item.get("title", item.get("subject", ""))), board=item.get("boardName", item.get("board")), published_at=item.get("postTime", item.get("publishedAt", item.get("createTime"))), reply_count=item.get("replyCount", item.get("replies")), url=str(url))


def _reply_from_json(item: dict[str, Any]) -> Reply:
    return Reply(id=str(item.get("id", item.get("postId", ""))), author=item.get("authorName", item.get("author")), content=str(item.get("content", item.get("text", ""))), floor=item.get("floor", item.get("index")), published_at=item.get("postTime", item.get("publishedAt")))


async def fetch_all_replies(client: CC98Client, token: str, topic_id: str, *, max_pages: int = 20) -> list[Reply]:
    all_replies: list[Reply] = []
    page = 1
    while True:
        replies, has_more = await client.get_replies(token, topic_id, page=page)
        all_replies.extend(replies)
        if not has_more or not replies or page >= max_pages:
            return all_replies
        page += 1
        await asyncio.sleep(0)
