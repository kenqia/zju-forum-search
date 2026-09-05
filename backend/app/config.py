from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    cc98_api_base: str = "https://api.cc98.org"
    cc98_topic_search_path: str = "/topic/search"
    cc98_timeout_seconds: float = 15.0
    # CC98's school-network endpoint should bypass a general-purpose VPN proxy
    # by default. Set ZJU_CC98_TRUST_ENV=true to opt back into HTTP(S)_PROXY.
    cc98_trust_env: bool = False
    multi_request_enabled: bool = False
    multi_request_max_requests: int = 3
    multi_request_timeout_seconds: float = 20.0
    multi_request_delay_seconds: float = 0.25
    max_reply_pages: int = 20
    llm_experiment_enabled: bool = False
    llm_endpoint: str = ""
    frontend_origin: str = "http://localhost:5173"
    model_config = SettingsConfigDict(env_file=".env", env_prefix="ZJU_", extra="ignore")


settings = Settings()
