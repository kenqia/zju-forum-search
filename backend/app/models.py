from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel, Field, HttpUrl


class LoginRequest(BaseModel):
    access_token: str = Field(min_length=1, max_length=4096)


class AuthStatus(BaseModel):
    authenticated: bool
    expires_at: datetime | None = None


class QueryPlan(BaseModel):
    original_query: str
    terms: list[str]


class TopicSummary(BaseModel):
    id: str
    title: str
    board: str | None = None
    published_at: str | None = None
    reply_count: int | None = None
    url: str


class Reply(BaseModel):
    id: str
    author: str | None = None
    content: str
    floor: int | None = None
    published_at: str | None = None


class SearchResult(BaseModel):
    topic: TopicSummary
    replies: list[Reply] = Field(default_factory=list)
    score: float = 0
    evidence: str | None = None
    reason: str = ""


class SearchResponse(BaseModel):
    query: QueryPlan
    results: list[SearchResult]
    partial: bool = False
    stop_reason: str | None = None
    requests_made: int = 1
    llm_experiment: bool = False
    llm_fallback: str | None = None
