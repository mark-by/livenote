#!/usr/bin/env bash
# Smoke-проверка LiveNote: поднимает сервер, гоняет REST, SSE и MCP-сценарий.
# Использование: scripts/smoke.sh [порт]
set -euo pipefail

PORT="${1:-4599}"
BASE="http://127.0.0.1:${PORT}"
DB="/tmp/livenote-smoke-${PORT}.sqlite"
LOG="/tmp/livenote-smoke-${PORT}.log"

rm -f "$DB" "$DB-wal" "$DB-shm"

node dist/server/index.js --port "$PORT" --db "$DB" >"$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if curl -sf "$BASE/api/config" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

step() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; exit 1; }

mcp_call() {
  curl -sf -X POST "$BASE/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "$1"
}

# Извлекает JSON-результат инструмента: последний text-контент call-ответа.
tool_payload() {
  echo "$1" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      const response = JSON.parse(s);
      const texts = response.result.content.filter((c) => c.type === "text");
      process.stdout.write(texts[texts.length - 1].text);
    });
  '
}

require_field() {
  echo "$1" | node -e "
    let s = '';
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => {
      const value = JSON.parse(s)$2;
      if (value === undefined || value === null) { process.exit(1); }
    });
  " || fail "$3"
}

step "config"
curl -sf "$BASE/api/config" | grep -q '"tokenRequired":false' || fail "config"
echo OK

step "REST: пустой список страниц"
PAGES=$(curl -sf "$BASE/api/pages")
[ "$PAGES" = '{"pages":[]}' ] || fail "ожидался пустой список, получено: $PAGES"
echo OK

step "REST: создание страницы"
PAGE=$(curl -sf -X POST "$BASE/api/pages" -H 'Content-Type: application/json' -d '{"title":"Smoke-страница"}')
PAGE_ID=$(echo "$PAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).page.id))')
[ -n "$PAGE_ID" ] || fail "не получили page id"
echo "page_id=$PAGE_ID"

step "REST: конфликт ревизии (ожидаем 409)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/pages/$PAGE_ID" \
  -H 'Content-Type: application/json' -d '{"title":"x","expectedRevision":999}')
[ "$CODE" = "409" ] || fail "ожидался 409, получен $CODE"
echo OK

step "REST: SSE hello"
# SSE-стрим не завершается сам: снимаем первые 2 секунды и проверяем приветствие.
curl -s -N --max-time 2 "$BASE/events" > /tmp/livenote-smoke-sse.out || true
grep -q 'event: hello' /tmp/livenote-smoke-sse.out || fail "нет события hello"
echo OK

step "MCP: initialize"
INIT=$(mcp_call '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}')
echo "$INIT" | grep -q '"livenote"' || fail "нет имени сервера в initialize"
echo OK

step "MCP: tools/list"
TOOLS=$(mcp_call '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
for t in list_pages get_page add_page write_markdown write_diagram check_diagram update_page delete_page; do
  echo "$TOOLS" | grep -q "\"name\":\"$t\"" || fail "нет инструмента $t"
done
echo OK

step "MCP: add_page + идемпотентность"
ADD_BODY='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_page","arguments":{"title":"Из MCP","request_id":"smoke-1"}}}'
RES=$(mcp_call "$ADD_BODY")
PAYLOAD=$(tool_payload "$RES")
require_field "$PAYLOAD" ".page_id" "add_page: нет page_id: $RES"
RES2=$(mcp_call '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"add_page","arguments":{"title":"Из MCP","request_id":"smoke-1"}}}')
PAYLOAD2=$(tool_payload "$RES2")
[ "$PAYLOAD" = "$PAYLOAD2" ] || fail "повторный add_page вернул другой результат (идемпотентность сломана): $PAYLOAD2"
echo OK

step "MCP: write_diagram (корректная схема)"
RES=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"write_diagram\",\"arguments\":{\"page_id\":\"$PAGE_ID\",\"block_id\":\"main-flow\",\"expected_revision\":1,\"source\":\"flowchart LR\\n  A[Request] --> B[Validation]\"}}}")
PAYLOAD=$(tool_payload "$RES")
require_field "$PAYLOAD" ".blockId" "write_diagram: нет blockId: $RES"
[ "$(echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))')" = "2" ] \
  || fail "write_diagram: ревизия не стала 2: $PAYLOAD"
SYNTAX=$(echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).validation.syntax))')
{ [ "$SYNTAX" = "ok" ] || [ "$SYNTAX" = "not_checked" ]; } || fail "write_diagram: неожиданная валидация: $SYNTAX"
echo OK

step "MCP: write_diagram с синтаксической ошибкой (ревизия НЕ должна измениться)"
RES=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"write_diagram\",\"arguments\":{\"page_id\":\"$PAGE_ID\",\"block_id\":\"broken\",\"expected_revision\":2,\"source\":\"flowchart LR\\n  A -->\"}}}")
PAYLOAD=$(tool_payload "$RES")
[ "$(echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).validation.syntax))')" = "error" ] \
  || fail "битая схема не вернула error: $RES"
[ "$(echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))')" = "2" ] \
  || fail "ошибка синтаксиса изменила ревизию"
echo OK

step "MCP: write_markdown"
RES=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"write_markdown\",\"arguments\":{\"page_id\":\"$PAGE_ID\",\"block_id\":\"intro\",\"expected_revision\":2,\"source\":\"# Пояснение\\n\\nТекст описания процесса.\"}}}")
PAYLOAD=$(tool_payload "$RES")
[ "$(echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))')" = "3" ] \
  || fail "write_markdown: ревизия не стала 3: $RES"
echo OK

step "MCP: get_page + check_diagram"
RES=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\"params\":{\"name\":\"get_page\",\"arguments\":{\"page_id\":\"$PAGE_ID\"}}}")
echo "$RES" | grep -q 'main-flow' || fail "get_page: нет main-flow"
RES=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"check_diagram\",\"arguments\":{\"page_id\":\"$PAGE_ID\",\"block_id\":\"main-flow\",\"mode\":\"syntax\"}}}")
PAYLOAD=$(tool_payload "$RES")
require_field "$PAYLOAD" ".stale" "check_diagram: нет stale: $RES"
echo OK

step "REST: экспорт страницы"
EXPORT=$(curl -sf "$BASE/api/export/pages/$PAGE_ID.md")
echo "$EXPORT" | grep -q '```mermaid' || fail "в экспорте нет mermaid-фенса"
echo "$EXPORT" | grep -q 'Пояснение' || fail "в экспорте нет markdown-блока"
echo OK

step "REST: импорт markdown"
IMPORT=$(curl -sf -X POST "$BASE/api/import" -H 'Content-Type: application/json' \
  -d '{"title":"Импорт","content":"# Импортировано\n\nТекст до.\n\n```mermaid\nflowchart TD\n  X --> Y\n```\n\nТекст после.\n"}')
BLOCKS_COUNT=$(echo "$IMPORT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(p.page.blocks.length)})')
[ "$BLOCKS_COUNT" = "3" ] || fail "ожидалось 3 блока при импорте, получено $BLOCKS_COUNT"
echo OK

step "REST: подтверждение рендера"
RENDER_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/pages/$PAGE_ID/blocks/main-flow/rendered" \
  -H 'Content-Type: application/json' -d '{"revision":2,"ok":true}')
[ "$RENDER_CODE" = "204" ] || fail "rendered подтверждение: $RENDER_CODE"
PAGE=$(curl -sf "$BASE/api/pages/$PAGE_ID")
RENDERED=$(echo "$PAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s).page.blocks.find(x=>x.id==="main-flow");console.log(b.renderedRevision)})')
[ "$RENDERED" = "2" ] || fail "renderedRevision не сохранился: $RENDERED"
echo OK

# Тело MCP-запроса для BPMN собирается в node — корректное экранирование XML в JSON.
mcp_bpmn_body() {
  node -e '
    const [pageId, revision, blockId, layoutArg] = process.argv.slice(1);
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<b:definitions xmlns:b="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <b:process id="P1" isExecutable="false">
    <b:startEvent id="s1" name="Заказ получен"/>
    <b:sequenceFlow id="f1" sourceRef="s1" targetRef="t1"/>
    <b:task id="t1" name="Обработать заказ"/>
    <b:sequenceFlow id="f2" sourceRef="t1" targetRef="e1"/>
    <b:endEvent id="e1" name="Заказ обработан"/>
  </b:process>
</b:definitions>`;
    const args = {
      page_id: pageId,
      block_id: blockId,
      expected_revision: Number(revision),
      format: "bpmn",
      source
    };
    if (layoutArg !== undefined && layoutArg !== "") { args.layout = layoutArg; }
    console.log(JSON.stringify({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "write_diagram", arguments: args } }));
  ' "$1" "$2" "$3" "${4:-}"
}

step "MCP: write_diagram bpmn (layout auto, XML без BPMNDI)"
RES=$(mcp_call "$(mcp_bpmn_body "$PAGE_ID" 3 order auto)")
PAYLOAD=$(tool_payload "$RES")
[ "$(echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))')" = "4" ] \
  || fail "bpmn auto: ревизия не стала 4: $RES"
echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).validation;if(v.syntax!=="ok"||v.hasDiagram!==true){process.exit(1)}})' \
  || fail "bpmn auto: валидация не ok/без DI: $PAYLOAD"
echo OK

step "MCP: write_diagram bpmn preserve без BPMNDI (ожидаем ошибку)"
RES=$(mcp_call "$(mcp_bpmn_body "$PAGE_ID" 4 order-no-di)")
PAYLOAD=$(tool_payload "$RES")
[ "$(echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).validation.syntax))')" = "error" ] \
  || fail "bpmn preserve без DI: ожидалась error: $RES"
[ "$(echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))')" = "4" ] \
  || fail "bpmn preserve без DI: ревизия изменилась"
echo OK

step "MCP: layout_diagram на bpmn-блоке"
RES=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":31,\"method\":\"tools/call\",\"params\":{\"name\":\"layout_diagram\",\"arguments\":{\"page_id\":\"$PAGE_ID\",\"block_id\":\"order\",\"expected_revision\":4}}}")
PAYLOAD=$(tool_payload "$RES")
[ "$(echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))')" = "5" ] \
  || fail "layout_diagram: ревизия не стала 5: $RES"
echo OK

step "MCP: check_diagram syntax на bpmn (bpmnlint)"
RES=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":32,\"method\":\"tools/call\",\"params\":{\"name\":\"check_diagram\",\"arguments\":{\"page_id\":\"$PAGE_ID\",\"block_id\":\"order\",\"mode\":\"syntax\"}}}")
PAYLOAD=$(tool_payload "$RES")
echo "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).validation;if(v.syntax!=="ok"||!Array.isArray(v.lint)){process.exit(1)}})' \
  || fail "check bpmn syntax: нет lint или не ok: $RES"
echo OK

step "REST: экспорт содержит bpmn-фенс"
EXPORT=$(curl -sf "$BASE/api/export/pages/$PAGE_ID.md")
echo "$EXPORT" | grep -q '```bpmn' || fail "в экспорте нет bpmn-фенса"
echo OK

step "REST: импорт markdown с bpmn-фенсом"
IMPORT=$(curl -sf -X POST "$BASE/api/import" -H 'Content-Type: application/json' \
  -d '{"title":"Импорт BPMN","content":"Текст.\n\n```bpmn\n<b:definitions xmlns:b=\"http://www.omg.org/spec/BPMN/20100524/MODEL\"><b:process id=\"P2\"/></b:definitions>\n```\n"}')
BLOCKS_TYPES=$(echo "$IMPORT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(p.page.blocks.map(b=>b.type).join(":"))})')
[ "$BLOCKS_TYPES" = "markdown:bpmn" ] || fail "импорт bpmn: ожидались блоки markdown:bpmn, получено $BLOCKS_TYPES"
echo OK

printf '\n===== SMOKE ПРОЙДЕН =====\n'
