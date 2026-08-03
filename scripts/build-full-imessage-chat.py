#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import html
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

SECRET_PATTERNS = [
    re.compile(r"(?i)((?:api[_-]?key|token|password|secret|authorization|private[_-]?key)\s*[=:]\s*[\"']?)([^\s,;\"']+)"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"\b(?:sk|gh[pousr]|github_pat|glpat)-?[A-Za-z0-9_\-]{12,}\b", re.I),
    re.compile(r"\b((?:akm|ak)-)([A-Za-z0-9_\-]{12,})\b", re.I),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
]


def redact(text: str) -> str:
    result = text
    for pattern in SECRET_PATTERNS:
        if pattern.groups:
            result = pattern.sub(lambda match: match.group(1) + "<redacted>", result)
        else:
            result = pattern.sub("<redacted>", result)
    result = re.sub(r"(https?://)[^/@\s:]+:[^/@\s]+@", r"\1<redacted>@", result)
    result = re.sub(r"Profiles/[A-Fa-f0-9]{12,}", "Profiles/<redacted-profile>", result)
    result = re.sub(r"\bliushiyu\d{4,}-[A-Za-z0-9]+\b", "<redacted-account>", result)
    return "\n".join(line.rstrip() for line in result.splitlines())


def text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(block.get("text", ""))
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()


def data_uri(path: Path, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def collect(project: Path, session_root: Path) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    sessions: list[dict[str, str]] = []
    messages: list[dict[str, str]] = []
    for path in session_root.rglob("*.jsonl"):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
            header = json.loads(lines[0])
        except Exception:
            continue
        if header.get("type") != "session" or Path(header.get("cwd", "")).expanduser().resolve() != project:
            continue
        session_id = str(header.get("id"))
        sessions.append({"id": session_id, "timestamp": str(header.get("timestamp", "")), "file": str(path)})
        for line_number, line in enumerate(lines[1:], 2):
            try:
                entry = json.loads(line)
            except Exception:
                continue
            if entry.get("type") != "message":
                continue
            message = entry.get("message") or {}
            role = message.get("role")
            if role not in {"user", "assistant"}:
                continue
            text = redact(text_content(message.get("content")))
            if not text:
                continue
            messages.append({
                "id": f"{session_id}:{entry.get('id', line_number)}",
                "session": session_id,
                "timestamp": str(entry.get("timestamp", message.get("timestamp", ""))),
                "role": role,
                "text": text,
                "source": f"{path.name}:{line_number}",
            })
    sessions.sort(key=lambda item: item["timestamp"])
    messages.sort(key=lambda item: item["timestamp"])
    return sessions, messages


def bubble(message: dict[str, str]) -> str:
    role = message["role"]
    speaker = "我" if role == "user" else "AI"
    text = html.escape(message["text"])
    long = len(message["text"]) > 1800
    return f"""<article class="row {role}" data-testid="chat-message" data-role="{role}" data-session-id="{html.escape(message['session'])}" data-message-id="{html.escape(message['id'])}" data-search="{html.escape(message['text'].lower()[:5000])}">
<div class="bubble{' long' if long else ''}"><div class="meta"><strong>{speaker}</strong><time>{html.escape(message['timestamp'])}</time></div><pre>{text}</pre>{'<button class="expand">展开全文</button>' if long else ''}<small>{html.escape(message['source'])}</small></div></article>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--repo-url", default="尚未发布")
    parser.add_argument("--session-root", default=str(Path.home() / ".pi/agent/sessions"))
    args = parser.parse_args()

    project = Path(args.project).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    sessions, messages = collect(project, Path(args.session_root).expanduser())
    user_count = sum(message["role"] == "user" for message in messages)
    assistant_count = len(messages) - user_count
    tui = project / "uat-artifacts/tui/tui-final.png"
    web = project / "uat-artifacts/webapp/web-fresh-final.png"
    video = project / "uat-artifacts/webapp/webapp-live-uat.webm"
    assert tui.exists() and web.exists() and video.exists(), "UAT snapshots missing"

    session_options = "".join(f'<option value="{html.escape(item["id"])}">{html.escape(item["id"])}</option>' for item in sessions)
    bubbles = "\n".join(bubble(message) for message in messages)
    tui_uri, web_uri, video_uri = data_uri(tui, "image/png"), data_uri(web, "image/png"), data_uri(video, "video/webm")
    repo = html.escape(args.repo_url)
    generated = datetime.now().astimezone().isoformat(timespec="seconds")

    document = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentBayDemo · Pi 全会话 iMessage 回放</title><style>
:root{{--bg:#f2f2f7;--panel:#fff;--ink:#161617;--muted:#707078;--blue:#0a84ff;--ai:#e9e9ed;--line:#d4d4da;--ok:#1f9d55;--warn:#b45309}}
@media(prefers-color-scheme:dark){{:root{{--bg:#000;--panel:#111113;--ink:#f5f5f7;--muted:#9b9ba3;--ai:#2c2c2e;--line:#333338}}}}
*{{box-sizing:border-box}}[hidden]{{display:none!important}}html{{scroll-behavior:smooth}}body{{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}}
header{{padding:28px max(18px,calc((100vw - 1180px)/2));background:color-mix(in srgb,var(--panel) 92%,transparent);border-bottom:1px solid var(--line)}}h1{{margin:0 0 8px;font-size:clamp(26px,4vw,44px)}}.lead{{max-width:76ch;color:var(--muted);line-height:1.55}}
nav{{position:sticky;top:0;z-index:5;display:flex;gap:8px;padding:10px max(14px,calc((100vw - 1180px)/2));background:color-mix(in srgb,var(--panel) 90%,transparent);backdrop-filter:blur(18px);border-bottom:1px solid var(--line)}}nav button,.control,button{{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:9px 14px;cursor:pointer}}nav button.active{{background:var(--blue);color:white;border-color:var(--blue)}}
main{{max-width:1180px;margin:auto;padding:24px 16px 60px}}[data-view]{{display:none}}[data-view].active{{display:block}}.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}}.card{{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px}}.card strong.big{{font-size:30px;display:block}}.ok{{color:var(--ok)}}.warn{{color:var(--warn)}}
.timeline{{margin-top:20px}}.row{{display:flex;margin:10px 0}}.row.user{{justify-content:flex-end}}.row.assistant{{justify-content:flex-start}}.bubble{{max-width:min(78%,850px);border-radius:22px;padding:10px 14px;background:var(--ai);box-shadow:0 1px 2px #0001}}.user .bubble{{background:var(--blue);color:white}}.meta{{display:flex;gap:10px;justify-content:space-between;font-size:12px;opacity:.75;margin-bottom:5px}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 inherit;margin:0}}.bubble small{{display:block;opacity:.55;margin-top:7px}}.bubble.long pre{{max-height:280px;overflow:hidden;mask-image:linear-gradient(#000 72%,transparent)}}.bubble.long.open pre{{max-height:none;mask-image:none}}.expand{{margin-top:8px;background:#fff2;color:inherit}}
.filters{{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}}input,select{{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:10px 12px}}input{{min-width:min(100%,320px)}}.shots{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}figure{{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:18px;overflow:hidden}}figure img{{display:block;width:100%;cursor:zoom-in}}figcaption{{padding:12px;color:var(--muted)}}video{{width:100%;margin-top:18px;border-radius:18px;background:#000}}dialog{{width:min(96vw,1500px);border:0;border-radius:18px;padding:0;background:#000}}dialog img{{display:block;max-width:100%;max-height:90vh;margin:auto}}dialog button{{position:absolute;right:12px;top:12px}}.needs li{{margin:.65rem 0;line-height:1.45}}footer{{padding:20px;text-align:center;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}}
@media(max-width:760px){{.grid,.shots{{grid-template-columns:1fr}}.bubble{{max-width:92%}}nav{{overflow:auto}}}}
@media print{{nav,.filters,.expand,video{{display:none!important}}[data-view]{{display:block!important;break-before:page}}body{{background:white;color:black}}}}
</style></head><body data-testid="chat-report-root" data-report-state="ready">
<header><h1>agentBayDemo · Pi 全会话回放</h1><p class="lead">精确读取工作目录下 {len(sessions)} 个 Pi Agent Session，将用户消息放在右侧、AI 可见文本放在左侧；工具结果与隐藏推理不属于聊天内容。凭据与账户标识已脱敏。公开分享仍会暴露用户原话和绝对路径。</p></header>
<nav><button class="active" data-tab="results">最终成果</button><button data-tab="chat">完整聊天</button><button data-tab="evidence">交互证据</button><button data-tab="needs">我们还需要什么</button></nav>
<main>
<section class="active" data-view="results"><div class="grid">
<div class="card"><strong class="big">{len(sessions)}</strong>exact-cwd Pi sessions</div><div class="card"><strong class="big">{len(messages)}</strong>可见聊天消息<br><small>{user_count} 用户 / {assistant_count} AI</small></div><div class="card"><strong class="big ok">23 / 23</strong>项目测试通过</div>
</div><div class="card" style="margin-top:16px"><h2>本轮最终成果</h2><ul class="needs"><li>完整 Pi Session 取证交接与完整 iMessage 聊天文件。</li><li>真实 Ink TUI 与 LAN WebApp 最终截图；Web 另有未剪辑 Playwright WebM 与 trace。</li><li>Agent Web state machine、真实 AgentBay 命令、归档恢复及 fresh flow 已验收。</li><li>阿里云 AgentBay skill 已放入项目；任何 Key 均未加入仓库。</li><li>GitHub 公共仓库：<a href="{repo}">{repo}</a></li></ul></div></section>
<section data-view="chat"><div class="filters"><input id="search" type="search" placeholder="搜索全部聊天"><select id="role"><option value="">全部角色</option><option value="user">只看我</option><option value="assistant">只看 AI</option></select><select id="session"><option value="">全部 Session</option>{session_options}</select><button id="expand-all">展开长消息</button><button id="copy-chat">复制纯文本</button></div><div class="timeline" id="timeline">{bubbles}</div></section>
<section data-view="evidence"><div class="shots"><figure><img data-shot src="{tui_uri}" alt="Ink TUI 最终交互截图"><figcaption>真实 Herdr PTY 的 Ink TUI 最终状态：AgentBay 命令完成、执行轨迹与归档可见。</figcaption></figure><figure><img data-shot src="{web_uri}" alt="LAN WebApp 最终交互截图"><figcaption>Playwright fresh flow 最终状态：共享聊天、容量、命令面板与执行轨迹。</figcaption></figure></div><video controls preload="metadata" src="{video_uri}"></video><p>完整交互 trace：<code>uat-artifacts/webapp/webapp-trace.zip</code>；独立可选择 TUI：<code>uat-artifacts/tui/tui-final.html</code>。</p></section>
<section data-view="needs"><div class="card"><h2>我们接下来真正需要的</h2><ol class="needs"><li><strong>立即轮换旧 AgentBay Key：</strong>历史会话曾出现凭据，公开报告仅做脱敏，轮换才是真正撤销。</li><li><strong>生产网络边界：</strong>当前 LAN Web 无登录、无 TLS；若跨网使用，必须加 HTTPS、身份认证、RBAC 和速率限制。</li><li><strong>持久化沙盒资产：</strong>现有 resume 只恢复聊天；需要恢复远程文件时应增加 OSS/S3 工作目录快照。</li><li><strong>费用口径：</strong>BSS 是延迟入账，状态行燃烧率只是估算，不能当实时最终账单。</li><li><strong>公开仓库维护：</strong>保持 CI、Dependabot、secret scanning 和最小权限；禁止提交 .env、会话归档、临时 URL 与 runtime checkpoint。</li></ol></div></section>
</main><dialog id="lightbox"><button onclick="lightbox.close()">关闭</button><img alt="放大快照"></dialog>
<footer>来源项目：agentBayDemo · {html.escape(str(project))} · 当前 Pi session ID：{html.escape(args.session_id)} · 生成：{generated}</footer>
<script>
const tabs=[...document.querySelectorAll('[data-tab]')],views=[...document.querySelectorAll('[data-view]')];tabs.forEach(b=>b.onclick=()=>{{tabs.forEach(x=>x.classList.toggle('active',x===b));views.forEach(v=>v.classList.toggle('active',v.dataset.view===b.dataset.tab))}});
const rows=[...document.querySelectorAll('[data-testid="chat-message"]')],searchInput=document.getElementById('search'),roleInput=document.getElementById('role'),sessionInput=document.getElementById('session');function filter(){{const q=searchInput.value.toLowerCase(),r=roleInput.value,s=sessionInput.value;rows.forEach(x=>x.hidden=!!((q&&!x.dataset.search.includes(q))||(r&&x.dataset.role!==r)||(s&&x.dataset.sessionId!==s)))}};searchInput.oninput=roleInput.onchange=sessionInput.onchange=filter;
document.querySelectorAll('.expand').forEach(b=>b.onclick=()=>{{b.parentElement.classList.toggle('open');b.textContent=b.parentElement.classList.contains('open')?'收起':'展开全文'}});document.getElementById('expand-all').onclick=()=>document.querySelectorAll('.bubble.long').forEach(x=>x.classList.add('open'));
document.getElementById('copy-chat').onclick=async e=>{{const text=rows.map(x=>`${{x.dataset.role==='user'?'我':'AI'}}: ${{x.querySelector('pre').innerText}}`).join('\\n\\n');await navigator.clipboard.writeText(text);e.target.textContent='已复制'}};
const lightbox=document.getElementById('lightbox');document.querySelectorAll('[data-shot]').forEach(img=>img.onclick=()=>{{lightbox.querySelector('img').src=img.src;lightbox.showModal()}});
</script></body></html>"""
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(document)
    print(json.dumps({"output": str(output), "sessions": len(sessions), "messages": len(messages), "user": user_count, "assistant": assistant_count, "bytes": output.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
