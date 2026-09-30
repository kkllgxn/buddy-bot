/**
 * 喵喵旅行 · 每日任务脚本（先领礼物 → 再派出行，一次跑完）
 *
 * 用法：
 *   node daily.js               完整流程（先领后派，可放心重复运行）
 *   node daily.js --claim-only  只领礼物，不派出行
 *
 * 四态识别（对应成长中心页面的四种状态）：
 *   1. 旅行中（有倒计时）        → 跳过，不重复派
 *   2. 今日已派（已达每日上限）  → 跳过派出行（但领礼物仍会尝试，防漏领）
 *   3. 可领礼物                  → 点击领取（失败自动重试，最多 3 次）
 *   4. 可派出行                  → 派猫猫旅行
 *
 * 二次校验：
 *   - 领取成功以「服务端返回 code=0」为准，不是"请求发出去了"；
 *   - 派出成功以「回查 status 接口 state=traveling（出现倒计时）」为准。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const API_BASE = "https://www.workbuddy.cn";
const BUDDY_PATH = "/activity/growth/buddy/travel";
const TOKEN_FILE = path.join(__dirname, "token.json");

// 请求 UA：保持浏览器形态（与扩展插件保持一致）
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

// 重试配置
const CLAIM_RETRY_MAX = 3;
const DEPART_RETRY_MAX = 3;
const RETRY_DELAY_MS = 5000;
const VERIFY_DELAY_MS = 2000;

const claimOnly = process.argv.includes("--claim-only");

// ---------- 工具 ----------
function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(msg) {
  console.log(`[${nowStr()}] ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadToken() {
  // 云端（GitHub Actions）模式：从环境变量 BUDDY_TOKEN 读取
  const envToken = (process.env.BUDDY_TOKEN || "").trim();
  if (envToken) return envToken;
  // 本地模式：从 token.json 读取
  if (!fs.existsSync(TOKEN_FILE)) {
    log("❌ 未找到登录态 —— 请先运行一次登录：node login.js（或设置 BUDDY_TOKEN 环境变量）");
    process.exit(1);
  }
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).token;
    if (!token) throw new Error("empty");
    return token;
  } catch {
    log("❌ token.json 内容异常 —— 请删除该文件后重新运行：node login.js");
    process.exit(1);
  }
}

// ---------- 接口层 ----------
async function callApi(token, sub, method = "GET", body) {
  const resp = await fetch(`${API_BASE}${BUDDY_PATH}/${sub}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${token}`,
      "user-agent": UA,
      origin: API_BASE,
      referer: `${API_BASE}/profile/growth-center`,
      "x-client-platform": "web",
    },
    body: body !== undefined ? body : undefined,
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error("AUTH_EXPIRED");
  }

  let json = {};
  try {
    json = await resp.json();
  } catch {
    /* 响应体非 JSON 时按空对象处理 */
  }
  if (!resp.ok && json.code === undefined) {
    throw new Error(`HTTP_${resp.status}`);
  }
  return json;
}

/** 查询喵喵状态（四态识别的数据来源） */
async function fetchStatus(token) {
  const json = await callApi(token, "status");
  if (json?.code !== 0) throw new Error(json?.msg || `code=${json?.code}`);
  const d = json?.data ?? {};
  return {
    state: d.state, // "traveling" | "idle" | ...
    departAt: d.depart_at, // 秒级时间戳
    arriveAt: d.arrive_at, // 秒级时间戳
    serverNow: d.server_now,
    durationHours: d.duration_hours ?? d.location?.duration_hours,
    dailyLimitReached: d.daily_limit_reached === true,
    locationName: d.location?.name,
  };
}

/** 领取积分。claimed=true 表示服务端已确认（code=0） */
async function claimOnce(token) {
  const json = await callApi(token, "claim", "POST", "{}");
  if (json?.code === 0) return { claimed: true, credit: json?.data?.credit };
  const msg = json?.msg ?? `code=${json?.code}`;
  // "no unclaimed travel" = 当前没有可领的礼物，属于正常状态，不算失败
  if (/no unclaimed/i.test(msg)) return { nothingToClaim: true };
  return { error: msg };
}

/** 派出喵喵 */
async function departOnce(token) {
  const json = await callApi(token, "depart", "POST", JSON.stringify({ location_id: 1 }));
  if (json?.code === 0) return { ok: true };
  return { error: json?.msg ?? `code=${json?.code}` };
}

/** 从旅行记录里取本趟真实到账积分（status/claim 里的 reward_credit 实测不可靠） */
async function fetchRealCredit(token, departAt) {
  try {
    const json = await callApi(token, "records?page=1&page_size=20");
    if (json?.code !== 0) return undefined;
    const records = json?.data?.records ?? [];
    const hit = departAt != null ? records.find((r) => r.depart_at === departAt) : undefined;
    const credit = (hit ?? records[0])?.reward_credit;
    return typeof credit === "number" ? credit : undefined;
  } catch {
    return undefined;
  }
}

/** 二次校验：派出后回查 status，确认真的进入「旅行中」（倒计时出现） */
async function verifyTraveling(token) {
  try {
    const st = await fetchStatus(token);
    return st.state === "traveling" && (st.arriveAt ?? 0) > 0 ? st : null;
  } catch {
    return null;
  }
}

// ---------- 业务流程 ----------
async function doClaim(token) {
  for (let attempt = 1; attempt <= CLAIM_RETRY_MAX; attempt++) {
    try {
      const r = await claimOnce(token);
      if (r.nothingToClaim) {
        log("🎁 礼物：当前没有可领取的旅行积分（可能已领过）");
        return true;
      }
      if (r.claimed) {
        let credit = r.credit;
        if (!(credit > 0)) credit = await fetchRealCredit(token); // 响应缺数量时从记录兜底
        log(credit > 0 ? `🎁 礼物：领取成功，+${credit} 积分` : "🎁 礼物：领取成功（到账积分以成长中心为准）");
        return true;
      }
      throw new Error(r.error || "未知错误");
    } catch (e) {
      log(`⚠️ 礼物：第 ${attempt}/${CLAIM_RETRY_MAX} 次领取失败：${e.message}`);
      if (attempt < CLAIM_RETRY_MAX) await sleep(RETRY_DELAY_MS);
    }
  }
  log("❌ 礼物：重试 3 次仍失败，本次跳过领取（下次运行会再试）");
  return false;
}

async function doDepart(token) {
  for (let attempt = 1; attempt <= DEPART_RETRY_MAX; attempt++) {
    try {
      const r = await departOnce(token);
      if (!r.ok) throw new Error(r.error || "未知错误");

      // 二次校验：不能只判断"点到了"，必须确认状态真的变了
      await sleep(VERIFY_DELAY_MS);
      const st = await verifyTraveling(token);
      if (st) {
        const hours = st.durationHours > 0 ? st.durationHours : "?";
        const dest = st.locationName ? `，目的地：${st.locationName}` : "";
        log(`🚀 出行：派出成功${dest}，旅行时长 ${hours} 小时（已确认进入旅行中）`);
        return true;
      }
      log(`⚠️ 出行：第 ${attempt} 次派出后回查未见「旅行中」状态，视为失败，准备重试`);
    } catch (e) {
      log(`⚠️ 出行：第 ${attempt}/${DEPART_RETRY_MAX} 次派出失败：${e.message}`);
    }
    if (attempt < DEPART_RETRY_MAX) await sleep(RETRY_DELAY_MS);
  }
  log("❌ 出行：重试 3 次仍失败，本次跳过派出（下次运行会再试）");
  return false;
}

async function main() {
  log("====== 喵喵旅行每日任务开始 ======");
  const token = loadToken();

  // 1) 先看状态：四态识别
  let st;
  try {
    st = await fetchStatus(token);
  } catch (e) {
    if (e.message === "AUTH_EXPIRED") {
      log("❌ 登录态已过期。请重新运行一次：node login.js（登录一次能用好几天到几周）");
      process.exit(2);
    }
    log(`❌ 查询状态失败：${e.message}`);
    process.exit(1);
  }

  const isTraveling = st.state === "traveling";
  if (isTraveling) {
    const nowSec = st.serverNow ?? Math.floor(Date.now() / 1000);
    const remain = Math.max(0, (st.arriveAt ?? 0) - nowSec);
    const h = Math.floor(remain / 3600);
    const m = Math.floor((remain % 3600) / 60);
    log(`🐾 喵喵正在旅行中（倒计时 ${h} 小时 ${m} 分），跳过派出行`);
    if (remain > 0) {
      log("====== 今日无需再操作，结束 ======");
      return; // 旅行中不用领礼物（礼物要等旅行回来才生成）
    }
    log("ℹ️ 倒计时已归零但服务端还是旅行中状态，按流程继续尝试领取");
  } else if (st.dailyLimitReached) {
    log("✅ 今日已派出过（达到每日上限）");
  } else {
    log("💤 喵喵当前空闲，可派出行");
  }

  // 2) 先领礼物（不随 0 点清零，漏领就浪费，所以每次运行都先尝试领）
  //    claim 对"无可领取"是幂等的，多调一次没有副作用
  if (!isTraveling || (st.arriveAt ?? 0) <= (st.serverNow ?? 0)) {
    await doClaim(token);
  }

  // 3) 再派出行（今日已派 / 旅行中 → 跳过，不重复派）
  if (claimOnly) {
    log("ℹ️ 已按 --claim-only 模式跳过派出行");
  } else if (isTraveling) {
    log("ℹ️ 旅行中，无需派出行");
  } else if (st.dailyLimitReached) {
    log("ℹ️ 今日已派过，跳过派出行");
  } else {
    await doDepart(token);
  }

  log("====== 喵喵旅行每日任务结束 ======");
}

main().catch((e) => {
  log(`❌ 运行异常：${e?.message ?? e}`);
  process.exit(1);
});
