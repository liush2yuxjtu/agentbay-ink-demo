#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import re
from pathlib import Path

import pyte
from playwright.sync_api import sync_playwright

COLORS = {
    "black": "#0b0f14", "red": "#ff6b6b", "green": "#72d572", "brown": "#e5c07b",
    "blue": "#61afef", "magenta": "#c678dd", "cyan": "#56b6c2", "white": "#d7dae0",
    "brightblack": "#6b7280", "brightred": "#ff8787", "brightgreen": "#95e06c",
    "brightbrown": "#ffd166", "brightblue": "#7cc7ff", "brightmagenta": "#df8cff",
    "brightcyan": "#7fdbff", "brightwhite": "#ffffff", "default": "#d7dae0",
}


def color(value: str, fallback: str) -> str:
    if value == "default":
        return fallback
    if value.startswith("#"):
        return value
    if re.fullmatch(r"[0-9a-fA-F]{6}", value):
        return f"#{value}"
    return COLORS.get(value, fallback)


def render_line(screen: pyte.Screen, row: int) -> str:
    cells = screen.buffer[row]
    parts: list[str] = []
    current_style = None
    text = ""
    for column in range(screen.columns):
        cell = cells[column]
        fg, bg = color(cell.fg, "#d7dae0"), color(cell.bg, "#0b0f14")
        if cell.reverse:
            fg, bg = bg, fg
        style = (
            f"color:{fg};background:{bg};"
            f"font-weight:{'700' if cell.bold else '400'};"
            f"font-style:{'italic' if cell.italics else 'normal'};"
            f"text-decoration:{'underline' if cell.underscore else 'none'}"
        )
        if style != current_style:
            if text:
                parts.append(f'<span style="{current_style}">{html.escape(text)}</span>')
            current_style, text = style, cell.data
        else:
            text += cell.data
    if text:
        parts.append(f'<span style="{current_style}">{html.escape(text.rstrip())}</span>')
    return "".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--png")
    parser.add_argument("--session-id", required=True)
    args = parser.parse_args()

    raw = Path(args.input).read_text(errors="replace")
    header = raw.find("\x1b[0m\x1b[38;5;6m╭")
    if header >= 0:
        raw = raw[header:]
    raw = raw.replace("\r\n", "\n").replace("\n", "\r\n")
    screen = pyte.Screen(120, 60)
    pyte.Stream(screen).feed(raw)
    lines = [render_line(screen, row) for row in range(screen.lines)]
    while lines and not lines[-1].replace("&nbsp;", "").strip():
        lines.pop()
    terminal = "\n".join(lines)
    visible_text = "\n".join(screen.display).rstrip()

    document = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentBay Ink TUI · UAT 快照</title><style>
:root{{--bg:#0a0d12;--panel:#111720;--ink:#e5e7eb;--muted:#98a2b3;--cyan:#56b6c2}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui;padding:24px}}
header,.tools,footer{{max-width:1540px;margin:auto}}h1{{margin:.2rem 0;font-size:22px}}p{{color:var(--muted)}}
.tools{{display:flex;gap:8px;margin:14px auto}}button{{background:#182230;color:#dce8f5;border:1px solid #334155;border-radius:8px;padding:8px 12px;cursor:pointer}}
.terminal{{max-width:1540px;margin:auto;overflow:auto;background:#0b0f14;border:1px solid #263241;border-radius:14px;padding:18px;box-shadow:0 18px 50px #0008}}
pre{{margin:0;white-space:pre;font:14px/1.35 SFMono-Regular,Consolas,Liberation Mono,monospace;min-width:max-content}}
footer{{margin-top:14px;color:var(--muted);font-size:12px}}@media(max-width:700px){{body{{padding:10px}}pre{{font-size:10px}}}}
</style></head><body data-testid="tui-snapshot" data-snapshot-state="ready">
<header><h1>AgentBay Ink TUI · 最终交互快照</h1><p>真实 Herdr PTY 可见屏幕，保留 ANSI 色彩与完整可选择文本。</p></header>
<div class="tools"><button id="copy">复制终端文本</button><button id="zoom">切换紧凑显示</button></div>
<section class="terminal"><pre id="terminal">{terminal}</pre></section>
<footer>来源项目：agentBayDemo · /Users/liushiyuwin/projects/agentBayDemo · 当前 Pi session ID：{html.escape(args.session_id)}</footer>
<script>const text={visible_text!r};document.getElementById('copy').onclick=async()=>{{await navigator.clipboard.writeText(text);document.getElementById('copy').textContent='已复制'}};document.getElementById('zoom').onclick=()=>document.querySelector('pre').style.fontSize=document.querySelector('pre').style.fontSize?'':'11px';</script>
</body></html>"""
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(document)

    if args.png:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1)
            page.goto(output.resolve().as_uri())
            page.locator("[data-testid='tui-snapshot'][data-snapshot-state='ready']").wait_for()
            page.screenshot(path=args.png, full_page=True)
            browser.close()
    print(f"TUI_SNAPSHOT_PASS html={output} png={args.png or '-'}")


if __name__ == "__main__":
    main()
