"""Independent decision-provider adapters.

This module intentionally has no dependency on Vivic runtime code.  It only
normalizes a JSON decision endpoint into an explicit result state so a future
core integration can choose whether to accept or fall back.
"""
from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import json
import math
import os
import socket
import threading
import time
from typing import Any, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


SCHEMA_VERSION = "vivic-decision-provider-1"
TERMINAL_STATES = {"accepted", "deferred", "error", "timeout", "cancelled", "disabled"}


@dataclass(frozen=True)
class DecisionRequest:
    utterance: str
    context: Mapping[str, Any]
    choices: list[Mapping[str, Any]]
    request_id: Optional[str] = None

    def as_payload(self) -> dict[str, Any]:
        if not isinstance(self.utterance, str) or not self.utterance.strip() or len(self.utterance) > 10000:
            raise ValueError("utterance must be a nonempty string of at most 10000 characters")
        if not isinstance(self.context, Mapping):
            raise ValueError("context must be an object")
        if self.request_id is not None and (not isinstance(self.request_id, str) or not self.request_id):
            raise ValueError("request_id must be a nonempty string when supplied")
        if not isinstance(self.choices, list) or not 1 <= len(self.choices) <= 256:
            raise ValueError("choices must contain between 1 and 256 candidates")
        ids = []
        for item in self.choices:
            if not isinstance(item, dict) or set(item) != {"id", "decision"}:
                raise ValueError("each candidate must contain only id and decision")
            if not isinstance(item["id"], str) or not item["id"] or len(item["id"]) > 128:
                raise ValueError("candidate ID must be a nonempty string")
            if not isinstance(item["decision"], dict):
                raise ValueError("candidate decision must be an object")
            ids.append(item["id"])
        if len(set(ids)) != len(ids):
            raise ValueError("candidate IDs must be unique")
        return {
            "schema_version": SCHEMA_VERSION,
            "request_id": self.request_id,
            "input": {
                "utterance": self.utterance,
                "context": dict(self.context),
                "choices": self.choices,
            },
        }


@dataclass(frozen=True)
class DecisionResult:
    state: str
    provider: str
    choice_id: Optional[str] = None
    probabilities: Optional[Mapping[str, float]] = None
    reason: Optional[str] = None
    latency_ms: Optional[float] = None

    def __post_init__(self) -> None:
        if self.state not in TERMINAL_STATES:
            raise ValueError(f"unknown decision state: {self.state}")

    @property
    def usable(self) -> bool:
        """Usable for offline scoring only, never permission to execute an action."""
        return self.state == "accepted" and self.choice_id is not None


class DecisionProvider:
    def decide(self, request: DecisionRequest, cancel: Optional[threading.Event] = None) -> DecisionResult:
        raise NotImplementedError


def _validate_response(value: Any, choices: list[Mapping[str, Any]]) -> tuple[str, Optional[dict[str, float]]]:
    if not isinstance(value, dict):
        raise ValueError("response must be a JSON object")
    allowed = {"choice_id", "probabilities"}
    if set(value) - allowed:
        raise ValueError("response contains unsupported fields")
    ids = [item["id"] for item in choices]
    choice = value.get("choice_id")
    probs = value.get("probabilities")
    if "choice_id" in value and not isinstance(choice, str):
        raise ValueError("choice_id must be a string when supplied")
    if "probabilities" in value and not isinstance(probs, dict):
        raise ValueError("probabilities must be an object when supplied")
    normalized: Optional[dict[str, float]] = None
    if probs is not None:
        if not isinstance(probs, dict) or set(probs) != set(ids):
            raise ValueError("probabilities must cover every candidate")
        normalized = {}
        for key, raw in probs.items():
            if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw) or raw < 0 or raw > 1:
                raise ValueError("probabilities must be finite numbers in [0,1]")
            normalized[key] = float(raw)
        if abs(sum(normalized.values()) - 1) > 1e-4:
            raise ValueError("probabilities must sum to one")
        # Ties use input candidate order, matching the portable benchmark.
        winner = max(ids, key=normalized.get)
        if choice is not None and choice != winner:
            raise ValueError("choice_id disagrees with probabilities")
        choice = winner
    if not isinstance(choice, str) or choice not in ids:
        raise ValueError("missing or unknown choice_id")
    return choice, normalized


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Authorization must never follow an endpoint-controlled redirect.
        return None


class HttpDecisionProvider(DecisionProvider):
    """HTTP adapter for either a hosted API or a local inference server."""

    def __init__(self, endpoint: str, *, name: str, timeout_s: float = 2.0,
                 model: Optional[str] = None, api_key_env: str = "BENCHMARK_API_KEY") -> None:
        parts = urlsplit(endpoint)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            raise ValueError("endpoint must be a complete HTTP(S) URL")
        if parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("endpoint must not include credentials, query or fragment")
        loopback = parts.hostname == "localhost"
        if not loopback:
            try:
                loopback = ipaddress.ip_address(parts.hostname).is_loopback
            except ValueError:
                pass
        if name == "local" and not loopback:
            raise ValueError("local endpoint must use a loopback host")
        if parts.scheme == "http" and not loopback:
            raise ValueError("remote endpoint must use HTTPS")
        if isinstance(timeout_s, bool) or not isinstance(timeout_s, (int, float)) or not math.isfinite(timeout_s) or not 0 < timeout_s <= 30:
            raise ValueError("timeout_s must be finite and between zero and 30 seconds")
        self.endpoint, self.name, self.timeout_s = endpoint, name, timeout_s
        self.model, self.api_key_env = model, api_key_env

    def decide(self, request: DecisionRequest, cancel: Optional[threading.Event] = None) -> DecisionResult:
        if cancel and cancel.is_set():
            return DecisionResult("cancelled", self.name, reason="cancelled before request")
        started = time.perf_counter()
        try:
            payload = request.as_payload()
            if self.model:
                payload["model"] = self.model
            serialized = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
            if len(serialized) > 2_000_000:
                raise ValueError("request exceeds 2MB")
        except (ValueError, TypeError, AttributeError, OverflowError):
            return DecisionResult("error", self.name, reason="invalid_request")
        if cancel and cancel.is_set():
            return DecisionResult("cancelled", self.name, reason="cancelled before request")
        headers = {"Content-Type": "application/json"}
        token = os.environ.get(self.api_key_env)
        if token:
            headers["Authorization"] = "Bearer " + token
        def result(state: str, reason: str) -> DecisionResult:
            if cancel and cancel.is_set():
                return DecisionResult("cancelled", self.name, reason="cancelled",
                                      latency_ms=(time.perf_counter() - started) * 1000)
            return DecisionResult(state, self.name, reason=reason,
                                  latency_ms=(time.perf_counter() - started) * 1000)
        try:
            req = Request(self.endpoint, serialized, headers)
            with build_opener(_NoRedirects()).open(req, timeout=self.timeout_s) as response:
                body = response.read(2_000_001)
            if cancel and cancel.is_set():
                return result("cancelled", "cancelled")
            if time.perf_counter() - started >= self.timeout_s:
                return result("timeout", "request timed out")
            if len(body) > 2_000_000:
                raise ValueError("response exceeds 2MB")
            decoded = json.loads(body)
            # Hosted chat endpoints may wrap the adapter response.
            if isinstance(decoded, dict) and "choices" in decoded:
                completions = decoded["choices"]
                if not isinstance(completions, list) or len(completions) != 1:
                    raise ValueError("chat wrapper must have exactly one completion")
                completion = completions[0]
                if not isinstance(completion, dict) or completion.get("finish_reason") != "stop":
                    raise ValueError("chat completion did not finish normally")
                message = completion.get("message")
                if not isinstance(message, dict) or message.get("tool_calls") or message.get("refusal"):
                    raise ValueError("chat completion is not a final decision")
                decoded = json.loads(message["content"])
            choice, probabilities = _validate_response(decoded, request.choices)
            if cancel and cancel.is_set():
                return result("cancelled", "cancelled")
            return DecisionResult("accepted", self.name, choice, probabilities,
                                  latency_ms=(time.perf_counter() - started) * 1000)
        except TimeoutError:
            return result("timeout", "request timed out")
        except HTTPError as exc:
            code = exc.code
            exc.close()
            return result("error", f"http_{code}")
        except URLError as exc:
            if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                return result("timeout", "request timed out")
            return result("error", "transport_error")
        except OSError:
            return result("error", "transport_error")
        except (ValueError, KeyError, IndexError, TypeError):
            return result("error", "invalid_response")


class DecisionRouter(DecisionProvider):
    """Priority router with explicit disable and safe fallback semantics."""

    def __init__(self, primary: DecisionProvider, fallback: Optional[DecisionProvider] = None,
                 *, enabled: bool = True) -> None:
        self.primary, self.fallback, self.enabled = primary, fallback, enabled

    @staticmethod
    def _invoke(provider: DecisionProvider, request: DecisionRequest,
                cancel: Optional[threading.Event]) -> DecisionResult:
        try:
            result = provider.decide(request, cancel)
            if isinstance(result, DecisionResult):
                return result
        except Exception:
            # Providers may attach credentials or URLs to exception messages.
            pass
        return DecisionResult("error", "router", reason="provider_error")

    def decide(self, request: DecisionRequest, cancel: Optional[threading.Event] = None) -> DecisionResult:
        if not self.enabled:
            return DecisionResult("disabled", "router", reason="explicitly disabled")
        if cancel and cancel.is_set():
            return DecisionResult("cancelled", "router", reason="cancelled")
        first = self._invoke(self.primary, request, cancel)
        if cancel and cancel.is_set():
            return DecisionResult("cancelled", "router", reason="cancelled")
        if first.state not in {"error", "timeout"}:
            return first
        if cancel and cancel.is_set():
            return DecisionResult("cancelled", "router", reason="cancelled during fallback")
        if self.fallback is None:
            return first
        second = self._invoke(self.fallback, request, cancel)
        if cancel and cancel.is_set():
            return DecisionResult("cancelled", "router", reason="cancelled")
        if second.state == "accepted":
            return DecisionResult("accepted", second.provider, second.choice_id,
                                  second.probabilities, reason=f"fallback_after:{first.state}",
                                  latency_ms=second.latency_ms)
        return DecisionResult(second.state, second.provider, second.choice_id,
                              second.probabilities, reason=f"primary:{first.reason}; fallback:{second.reason}",
                              latency_ms=second.latency_ms)


def api_provider(endpoint: str, **kwargs: Any) -> HttpDecisionProvider:
    return HttpDecisionProvider(endpoint, name="api", **kwargs)


def local_provider(endpoint: str, **kwargs: Any) -> HttpDecisionProvider:
    return HttpDecisionProvider(endpoint, name="local", **kwargs)
