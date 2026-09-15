from __future__ import annotations

# Exception type names raised when the OpenAI-compatible LLM HTTP server is down,
# timing out, or returning a transient gateway/server error.
_RETRYABLE_TYPE_NAMES = frozenset(
    {
        "APIConnectionError",
        "APITimeoutError",
        "ConnectError",
        "ConnectTimeout",
        "ReadTimeout",
        "WriteTimeout",
        "PoolTimeout",
        "TimeoutException",
        "RemoteProtocolError",
        "LocalProtocolError",
        "ConnectionError",
        "ConnectionRefusedError",
        "ConnectionResetError",
        "BrokenPipeError",
        "TimeoutError",
        "HTTPStatusError",
    }
)

_RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})

_RETRYABLE_MESSAGE_FRAGMENTS = (
    "connection refused",
    "connect call failed",
    "failed to establish a new connection",
    "name or service not known",
    "temporary failure in name resolution",
    "nodename nor servname provided",
    "network is unreachable",
    "connection reset",
    "server disconnected",
    "all connection attempts failed",
)


def _exception_chain(exc: BaseException) -> list[BaseException]:
    chain: list[BaseException] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _status_code(exc: BaseException) -> int | None:
    for attr in ("status_code", "status"):
        value = getattr(exc, attr, None)
        if isinstance(value, int):
            return value
    response = getattr(exc, "response", None)
    if response is not None:
        value = getattr(response, "status_code", None)
        if isinstance(value, int):
            return value
    return None


def is_llm_unavailable(exc: BaseException) -> bool:
    """Return True when the LLM server looks crashed, unreachable, or temporarily failing."""
    for item in _exception_chain(exc):
        if type(item).__name__ in _RETRYABLE_TYPE_NAMES:
            return True
        status = _status_code(item)
        if status in _RETRYABLE_STATUS_CODES:
            return True
        message = str(item).lower()
        if any(fragment in message for fragment in _RETRYABLE_MESSAGE_FRAGMENTS):
            return True
    return False
