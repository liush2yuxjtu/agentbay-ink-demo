#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import Locator, Page, expect, sync_playwright

BASE = os.environ.get("AGENT_WEBAPP_URL", "http://127.0.0.1:8787/")
OUT = Path(os.environ.get("UAT_ARTIFACT_DIR", "uat-artifacts/webapp"))
LATEST = Path(".agent/agent-webapp-runtime/latest.json")
MAX_SILENCE = 15.0


def wait_for_terminal(page: Page, agent: Locator, timeout_s: int = 240) -> None:
    deadline = time.monotonic() + timeout_s
    previous = (agent.get_attribute("data-agent-state") or "", agent.inner_text())
    changed_at = time.monotonic()
    while time.monotonic() < deadline:
        current = (agent.get_attribute("data-agent-state") or "", agent.inner_text())
        if current[0] == "error":
            raise AssertionError(current[1][-500:])
        if current != previous:
            previous = current
            changed_at = time.monotonic()
        if current[0] == "completed":
            return
        if time.monotonic() - changed_at > MAX_SILENCE:
            raise AssertionError("Agent 页面连续 15 秒无可见状态或文本变化")
        page.wait_for_timeout(250)
    raise AssertionError(f"Agent 未在 {timeout_s} 秒内完成")


def send(page: Page, prompt: str) -> None:
    page.locator("[data-testid='agent-prompt']").fill(prompt)
    page.locator("[data-testid='agent-send']").click()


def final_text(page: Page) -> str:
    replies = page.locator("[data-testid='agent-final-response']")
    expect(replies).not_to_have_count(0)
    return replies.nth(replies.count() - 1).inner_text().strip()


def exit_and_checkpoint(page: Page, prompt: str) -> str:
    response = page.request.post(f"{BASE.rstrip('/')}/api/exit", data={})
    assert response.ok, f"exit/checkpoint failed: {response.status}"
    payload = response.json()
    session_id = payload.get("sessionId")
    assert payload.get("archived") is True and session_id, payload
    record = {
        "recorded_from": "runtime_api",
        "source_thread_id": session_id,
        "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
        "expected_state": "completed",
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "checkpoint": payload,
    }
    LATEST.parent.mkdir(parents=True, exist_ok=True)
    temporary = LATEST.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2))
    temporary.replace(LATEST)
    return session_id


def resume(page: Page, session_id: str) -> None:
    response = page.request.post(
        f"{BASE.rstrip('/')}/api/resume", data={"sessionId": session_id}
    )
    assert response.ok, f"resume failed: {response.status}"
    assert response.json().get("sessionId") == session_id
    page.reload(wait_until="domcontentloaded")
    agent = page.locator("[data-testid='agent-root']")
    expect(agent).to_have_count(1)
    wait_for_terminal(page, agent)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    failed_requests: list[str] = []
    marker = "WEB_UAT_READY_20260803"
    fresh_marker = "WEB_UAT_FRESH_20260803"
    prompt = f"请在 AgentBay 远程沙盒执行 printf '{marker}\\n'，并只回复 {marker}。"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1440, "height": 1100},
            record_video_dir=str(OUT),
            record_video_size={"width": 1440, "height": 1100},
        )
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
        page = context.new_page()
        page.on("console", lambda message: errors.append(f"console:{message.type}:{message.text}") if message.type == "error" else None)
        page.on("pageerror", lambda error: errors.append(f"page:{error}"))
        page.on(
            "requestfailed",
            lambda request: failed_requests.append(f"{request.method} {request.url}: {request.failure}")
            if "ERR_ABORTED" not in str(request.failure)
            else None,
        )
        page.goto(BASE, wait_until="domcontentloaded")

        guide = page.locator("[data-testid='guide-close']")
        if guide.is_visible():
            guide.click()

        agent = page.locator("[data-testid='agent-root']")
        expect(agent).to_have_count(1)
        wait_for_terminal(page, agent)
        page.screenshot(path=str(OUT / "web-initial.png"), full_page=True)

        send(page, prompt)
        expect(agent).to_have_attribute("data-agent-state", "streaming", timeout=15_000)
        page.screenshot(path=str(OUT / "web-streaming.png"), full_page=True)
        wait_for_terminal(page, agent)
        assert marker in final_text(page)
        page.screenshot(path=str(OUT / "web-final.png"), full_page=True)
        (OUT / "web-final-page.html").write_text(page.content())

        session_id = exit_and_checkpoint(page, prompt)
        resume(page, session_id)
        send(page, f"上一轮远程执行的标记是什么？只回复 {marker}。")
        wait_for_terminal(page, agent)
        assert marker in final_text(page)
        page.screenshot(path=str(OUT / "web-resumed.png"), full_page=True)
        exit_and_checkpoint(page, prompt)

        page.reload(wait_until="domcontentloaded")
        wait_for_terminal(page, agent)
        send(page, f"请在 AgentBay 远程沙盒执行 printf '{fresh_marker}\\n'，并只回复 {fresh_marker}。")
        wait_for_terminal(page, agent)
        assert fresh_marker in final_text(page)
        page.screenshot(path=str(OUT / "web-fresh-final.png"), full_page=True)
        exit_and_checkpoint(page, fresh_marker)

        video = page.video
        context.tracing.stop(path=str(OUT / "webapp-trace.zip"))
        context.close()
        video_path = Path(video.path())
        target_video = OUT / "webapp-live-uat.webm"
        video_path.replace(target_video)
        browser.close()

    assert not errors, errors
    assert not failed_requests, failed_requests
    evidence = {
        "status": "passed",
        "url": BASE,
        "state_machine": ["completed", "streaming", "completed", "resumed", "completed", "fresh", "completed"],
        "checkpoint": "saved through /api/exit and restored through /api/resume",
        "markers": [marker, fresh_marker],
        "screenshots": sorted(str(path) for path in OUT.glob("*.png")),
        "video": str(OUT / "webapp-live-uat.webm"),
        "trace": str(OUT / "webapp-trace.zip"),
        "console_errors": errors,
        "request_failures": failed_requests,
    }
    (OUT / "qa-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    print("WEBAPP_UAT_PASS", json.dumps(evidence, ensure_ascii=False))


if __name__ == "__main__":
    main()
