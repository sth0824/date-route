import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.MODEL || "claude-opus-5-5";
const EFFORT = process.env.EFFORT || "low";            // low = 빠른 응답. 더 꼼꼼하게: medium/high
const ACCESS_CODE = process.env.ACCESS_CODE || "";      // 설정하면 이 코드를 아는 사람만 사용 가능
const HOURLY_LIMIT = Number(process.env.HOURLY_LIMIT) || 20; // IP당 시간당 요청 수

const client = new Anthropic(); // ANTHROPIC_API_KEY 환경변수 사용

// ---------- 간단한 IP별 요청 제한 ----------
const hits = new Map();
function allow(ip) {
  const now = Date.now(), hour = 3600_000;
  const list = (hits.get(ip) || []).filter(t => now - t < hour);
  if (list.length >= HOURLY_LIMIT) { hits.set(ip, list); return false; }
  list.push(now); hits.set(ip, list); return true;
}

// ---------- 프롬프트 ----------
const pick = v => (Array.isArray(v) && v.length ? v.map(String).join(", ").slice(0, 200) : "상관없음");
function buildPrompt(b) {
  const now = new Date(Date.now() + 9 * 3600_000); // KST
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1, d = now.getUTCDate();
  const loc = String(b.location || "").trim().slice(0, 60);
  const where = b.mode === "hot"
    ? `오늘은 ${y}년 ${m}월 ${d}일이야. 웹 검색으로 요즘 서울·경기에서 데이트로 인기 있는 동네·핫플·이번 시기 행사(축제, 팝업, 전시, 단풍/야경 명소 등)를 찾아보고, 그중 한 동네를 골라 코스를 짜줘.` +
      (loc ? ` 참고로 사용자는 "${loc}" 근처에 살아.` : "")
    : `오늘은 ${y}년 ${m}월 ${d}일이야. 만나는 장소: "${loc}". 이 근처(대중교통 30분 이내)로 코스를 짜줘. 웹 검색으로 이 동네의 요즘 인기 있는 곳과 최근 정보(폐업 여부, 진행 중인 행사)를 확인해줘.`;
  return `너는 서울·경기 데이트 코스를 잘 아는 친구야. 한국어로 답해.
${where}
- 시간대: ${pick(b.time)}
- 하고 싶은 것: ${pick(b.vibe)}
- 예산: ${pick(b.budget)}
- 이동: ${pick(b.move)}

규칙:
- 정거장은 4~5곳, 실제 동선이 자연스럽게 이어지게.
- 검색으로 현재 운영 중임을 확인한 곳 위주로. 확인이 안 되는 개별 가게는 "OO역 인근 파스타 골목"처럼 거리·골목·랜드마크 단위로 적어.
- name은 지도에서 검색되는 이름 그대로, where는 동네나 가까운 역.
- desc는 왜 데이트에 좋은지 1~2문장, tip은 짧은 실전 팁(예약, 웨이팅, 기간 한정 등).
- sources에는 참고한 웹페이지를 최대 4개.

마지막 답변은 아래 형태의 JSON 하나만 출력해 (다른 말 없이):
{"title":"코스 이름(짧고 감성적으로)","area":"동네","summary":"한 문장 소개","stops":[{"time":"14:00","type":"카페","name":"장소명","where":"동네/역","desc":"...","tip":"...","cost":"1인 약 8,000원"}],"moves":["도보 7분"],"budget":"2인 약 10만원","rainy":"비 오면 대안 한 문장","sources":[{"title":"페이지 제목","url":"https://..."}]}
moves 길이는 stops보다 1 작게.`;
}

function parseCourse(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const c = JSON.parse(text.slice(s, e + 1));
    return c && Array.isArray(c.stops) && c.stops.length ? c : null;
  } catch { return null; }
}

async function makeCourse(body) {
  const messages = [{ role: "user", content: buildPrompt(body) }];
  const params = {
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT },
    tools: [{
      type: "web_search_20260209", name: "web_search", max_uses: 5,
      user_location: { type: "approximate", country: "KR", city: "Seoul", timezone: "Asia/Seoul" },
    }],
    messages,
  };
  let res = await client.beta.messages.create(params);
  for (let i = 0; res.stop_reason === "pause_turn" && i < 3; i++) {
    messages.push({ role: "assistant", content: res.content });
    res = await client.beta.messages.create({ ...params, messages });
  }
  if (res.stop_reason === "refusal") throw Object.assign(new Error("refused"), { status: 422 });
  // 검색 중간 설명 대신 마지막 텍스트 블록들에서 JSON을 찾음
  const texts = res.content.filter(b => b.type === "text").map(b => b.text);
  for (let i = texts.length - 1; i >= 0; i--) {
    const c = parseCourse(texts.slice(i).join(""));
    if (c) return c;
  }
  throw Object.assign(new Error("bad_format"), { status: 502 });
}

// ---------- HTTP ----------
const send = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error("too_large"); }
  return JSON.parse(raw || "{}");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await readFile(path.join(here, "public", "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    return send(res, 200, { needsCode: !!ACCESS_CODE });
  }
  if (req.method === "POST" && url.pathname === "/api/course") {
    if (ACCESS_CODE && req.headers["x-access-code"] !== ACCESS_CODE) return send(res, 401, { error: "wrong_code" });
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (!allow(ip)) return send(res, 429, { error: "rate_limited" });
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: "bad_request" }); }
    if (body.mode !== "hot" && !String(body.location || "").trim()) return send(res, 400, { error: "no_location" });
    try {
      return send(res, 200, await makeCourse(body));
    } catch (e) {
      console.error("course error:", e?.status, e?.message);
      if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: "rate_limited" });
      if (e?.status === 422) return send(res, 422, { error: "refused" });
      if (e?.message === "bad_format") return send(res, 502, { error: "bad_format" });
      return send(res, 502, { error: "upstream" });
    }
  }
  if (url.pathname === "/healthz") return send(res, 200, { ok: true });
  send(res, 404, { error: "not_found" });
});

server.requestTimeout = 0; // 웹 검색이 길어질 수 있음
server.listen(PORT, () => console.log(`데이트 노선도: http://localhost:${PORT}`));
