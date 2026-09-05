from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Iterable, Protocol

from .cc98 import CC98Client, CC98Error, fetch_all_replies
from .config import Settings, settings
from .models import QueryPlan, Reply, SearchResponse, SearchResult, TopicSummary


_STOPWORDS = {"我想", "帮我", "查找", "搜索", "一下", "相关", "的", "和", "有没有", "请问", "关于"}


def plan_query(query: str) -> QueryPlan:
    original = " ".join(query.strip().split())
    tokens = [t for t in re.split(r"[\s,，。！？!?、；;（）()]+", original) if t and t not in _STOPWORDS]
    terms: list[str] = []
    for token in tokens:
        cleaned = token
        for stopword in ["请帮我找", "帮我找", "我想", "帮我", "请问", "搜索", "查找"]:
            cleaned = cleaned.removeprefix(stopword)
        if cleaned and cleaned not in terms:
            terms.append(cleaned)
    # Keep an exact phrase first, then meaningful terms; this works for both Chinese and Latin input.
    planned = [original] + terms if original else []
    return QueryPlan(original_query=original, terms=planned[:8])


@dataclass
class SearchOptions:
    multi_request: bool = False
    llm_experiment: bool = False


class Reranker(Protocol):
    async def rerank(self, query: str, results: list[SearchResult]) -> list[SearchResult]: ...


class ModelProvider(Protocol):
    async def rerank(self, query: str, results: list[SearchResult]) -> list[SearchResult]: ...


class SearchService:
    def __init__(self, client: CC98Client, *, config: Settings = settings, model_provider: ModelProvider | None = None) -> None:
        self.client = client
        self.config = config
        self.model_provider = model_provider

    async def search(self, token: str, query: str, options: SearchOptions | None = None) -> SearchResponse:
        options = options or SearchOptions()
        plan = plan_query(query)
        if not plan.original_query:
            return SearchResponse(query=plan, results=[], partial=False, stop_reason="请输入搜索内容", requests_made=0)
        terms = plan.terms[:1]
        multi_allowed = options.multi_request and self.config.multi_request_enabled
        if multi_allowed:
            terms = plan.terms[: max(1, self.config.multi_request_max_requests)]
        results_by_id: dict[str, TopicSummary] = {}
        partial = False
        stop_reason: str | None = None
        started = time.monotonic()
        requests_made = 0
        for index, term in enumerate(terms):
            if index and time.monotonic() - started >= self.config.multi_request_timeout_seconds:
                partial, stop_reason = True, "达到总耗时边界"
                break
            try:
                topics = await self.client.search_topics(token, term)
                requests_made += 1
            except CC98Error as exc:
                if index == 0:
                    raise
                partial, stop_reason = True, str(exc)
                break
            for topic in topics:
                results_by_id.setdefault(topic.id, topic)
            if not multi_allowed:
                break
            if index + 1 < len(terms):
                await asyncio.sleep(max(0, self.config.multi_request_delay_seconds))
        results: list[SearchResult] = []
        for topic in results_by_id.values():
            try:
                replies = await fetch_all_replies(self.client, token, topic.id)
            except CC98Error as exc:
                if exc.kind in {"auth", "rate_limit"}:
                    partial, stop_reason = True, str(exc)
                    break
                replies = []
            results.append(_score_result(plan.original_query, topic, replies))
        results.sort(key=lambda result: (-result.score, result.topic.title.lower()))
        llm_fallback = None
        llm_used = bool(options.llm_experiment and self.config.llm_experiment_enabled)
        if llm_used and self.model_provider:
            try:
                results = await self.model_provider.rerank(plan.original_query, results)
            except Exception:
                llm_fallback = "外部 LLM 实验失败，已回退到本地排序"
        elif options.llm_experiment:
            llm_fallback = "外部 LLM 实验未启用，已使用本地排序"
        return SearchResponse(query=plan, results=results, partial=partial, stop_reason=stop_reason, requests_made=requests_made, llm_experiment=llm_used, llm_fallback=llm_fallback)


def _score_result(query: str, topic: TopicSummary, replies: Iterable[Reply]) -> SearchResult:
    unique: dict[str, Reply] = {}
    for reply in replies:
        key = reply.id or reply.content.strip()
        if key and key not in unique and reply.content.strip():
            unique[key] = reply
    clean_replies = list(unique.values())
    corpus = " ".join([topic.title, *[reply.content for reply in clean_replies]]).lower()
    terms = [token.lower() for token in re.split(r"[\s,，。！？!?、；;（）()]+", query) if token]
    hits = [token for token in terms if token in corpus]
    title_hits = [token for token in terms if token in topic.title.lower()]
    score = len(hits) + len(title_hits) * 2
    evidence = None
    reason = "未找到明显关键词匹配"
    if hits:
        matched = next((reply.content.strip() for reply in clean_replies if any(token in reply.content.lower() for token in hits)), None)
        evidence = (matched or topic.title).replace("\\n", " ")[:240]
        reason = f"命中 {len(set(hits))} 个查询词" + ("，标题命中" if title_hits else "")
    return SearchResult(topic=topic, replies=clean_replies, score=float(score), evidence=evidence, reason=reason)
