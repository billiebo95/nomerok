// Номерок: серверная функция для Supabase Edge Functions.
// Имя функции в Supabase должно быть: nomerok
// Секреты (Edge Functions → Secrets): BOT_TOKEN, ADMIN_CHAT_ID
//
// Что делает:
//  1. Принимает запросы мини-приложения: создать объявление, мои объявления,
//     отметить «Продано», снять, пожаловаться. Каждый запрос проверяется
//     подписью Telegram, поэтому подделать продавца нельзя.
//  2. Работает вебхуком бота: /start, /id и кнопки «Одобрить / Отклонить / Снять» у админа.
//  3. GET ?setup=1 — один раз подключает вебхук и кнопку меню бота.

const PROJECT_URL = "https://rfruubhnlvvvztxhlvez.supabase.co";
const APP_URL = "https://billiebo95.github.io/nomerok/";
const FN_URL = `${PROJECT_URL}/functions/v1/nomerok`;

const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const ADMIN = (Deno.env.get("ADMIN_CHAT_ID") ?? "").trim();
function secretKey(): string {
  const direct = Deno.env.get("SB_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  try { // новые проекты: SUPABASE_SECRET_KEYS = {"default":"sb_secret_..."}
    const m = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return m.default || Object.values(m)[0] as string || "";
  } catch { return ""; }
}
const KEY = secretKey();

const LETTERS = "АВЕКМНОРСТУХ";
const isAdmin = (id: unknown) => Boolean(ADMIN) && String(id) === ADMIN;
const ADMIN_COMMANDS = [
  { command: "start", description: "Открыть Номерок" },
  { command: "pending", description: "Объявления на проверке" },
  { command: "list", description: "Последние опубликованные (со снятием)" },
  { command: "del", description: "Снять объявление: /del 15" },
  { command: "stats", description: "Статистика" },
  { command: "paid", description: "Режим оплаты: бесплатно / платно" },
  { command: "admin", description: "Помощь модератора" },
];
const MAX_PENDING = 3;
const FREE_LIMIT = 100; // сколько объявлений размещаются бесплатно в режиме «Авто»
const TIERS = [
  { upTo: 150000, price: 99 },
  { upTo: 500000, price: 299 },
  { upTo: Infinity, price: 790 },
];
const MODE_LABEL: Record<string, string> = {
  auto: `Авто: первые ${FREE_LIMIT} бесплатно, потом платно`,
  free: "Всегда бесплатно",
  paid: "Платно сейчас",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- крипто ----------
const enc = new TextEncoder();
async function hmac(key: Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256(s: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };

// Проверка initData мини-приложения по документации Telegram
async function verifyInitData(initData: string): Promise<TgUser | null> {
  if (!initData || !BOT) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), BOT);
  const calc = hex(await hmac(secret, dcs));
  if (calc !== hash) return null;
  const authDate = Number(p.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // сессия старше суток
  try {
    return JSON.parse(p.get("user") || "null");
  } catch {
    return null;
  }
}

// ---------- база ----------
async function db(path: string, init: RequestInit = {}) {
  const h: Record<string, string> = { apikey: KEY, "Content-Type": "application/json", Prefer: "return=representation" };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  const r = await fetch(`${PROJECT_URL}/rest/v1/${path}`, { ...init, headers: { ...h, ...(init.headers as Record<string, string> || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`DB ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}

// ОЦЕНКА НОМЕРА (общий код для сайта и функции)
const EST_ELITE = ["АМР","ЕКХ","ММР","КМР","ОМР","ВОР","ХКХ","ЕРЕ","САС","ТМР"];
const EST_REG: Record<string, number> = {"77":1.5,"97":1.5,"99":1.5,"177":1.5,"197":1.5,"199":1.5,"777":1.4,"797":1.4,"799":1.4,"977":1.4,"78":1.25,"98":1.25,"178":1.25,"198":1.25,"50":1.15,"95":1.3,"20":1.3,"05":1.3,"06":1.2,"07":1.2,"15":1.2,"09":1.15,"26":1.1,"23":1.1};
function estimatePlate(l1: string, d: string, l2: string, r: string) {
  const L = l1 + l2, why: string[] = [];
  let lo: number, hi: number;
  const same = d[0] === d[1] && d[1] === d[2];
  if (d === "001") { lo = 400000; hi = 1500000; why.push("номер 001"); }
  else if (d === "007") { lo = 300000; hi = 1000000; why.push("номер 007"); }
  else if (/^00[1-9]$/.test(d)) { lo = 150000; hi = 500000; why.push("нули в начале"); }
  else if (d === "777") { lo = 300000; hi = 1000000; why.push("три семёрки"); }
  else if (same) { lo = 100000; hi = 400000; why.push("одинаковые цифры"); }
  else if (/^[1-9]00$/.test(d)) { lo = 50000; hi = 150000; why.push("круглые цифры"); }
  else if (/^0[1-9]0$/.test(d)) { lo = 50000; hi = 150000; why.push("красивые нули"); }
  else if (d[0] === d[2]) { lo = 15000; hi = 50000; why.push("зеркальные цифры"); }
  else if ("0123456789".includes(d) || "9876543210".includes(d)) { lo = 15000; hi = 40000; why.push("цифры по порядку"); }
  else if (d[0] === d[1] || d[1] === d[2]) { lo = 5000; hi = 20000; why.push("две одинаковые цифры"); }
  else { lo = 0; hi = 10000; }
  const letSame = l1 === l2[0] && l2[0] === l2[1];
  if (EST_ELITE.includes(L)) { lo = Math.max(lo * 4, 100000); hi = Math.max(hi * 4, 500000); why.push("серия " + L); }
  else if (letSame) { lo = Math.max(lo * 3, 30000); hi = Math.max(hi * 3, 100000); why.push("одинаковые буквы"); }
  else if (l2[0] === l2[1]) { lo *= 1.3; hi *= 1.3; }
  const k = EST_REG[r] || 1;
  if (k > 1.1 && hi > 20000) why.push("популярный регион");
  lo *= k; hi *= k;
  const round = (x: number) => x < 10000 ? Math.round(x / 1000) * 1000 : x < 100000 ? Math.round(x / 5000) * 5000 : x < 1000000 ? Math.round(x / 50000) * 50000 : Math.round(x / 100000) * 100000;
  return { lo: round(lo), hi: Math.max(round(hi), 10000), plain: why.length === 0, why };
}

function shortRub(x: number): string { if(x>=1e6) return (Math.round(x/1e5)/10).toString().replace(".",",")+" млн"; if(x>=1000) return Math.round(x/1000)+" тыс."; return String(x); }
function estRange(e: { lo: number; hi: number }): string { const a=shortRub(e.lo), b=shortRub(e.hi); const ua=a.split(" ")[1], ub=b.split(" ")[1]; return (e.lo===0?"до "+b:(ua===ub?a.split(" ")[0]+"–"+b:a+" – "+b))+" ₽"; }

// ---------- Telegram ----------
async function tg(method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
const h = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const plateText = (a: any) => `${a.l1}${a.d}${a.l2} ${a.r}`;
const money = (n: number) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";

function estLine(a: any) {
  const e = estimatePlate(a.l1, a.d, a.l2, a.r);
  const base = `Оценка: ${estRange(e)}${e.plain ? " (обычный номер)" : ""}`;
  if (a.price > e.hi * 2) return `${base}\n⚠️ Цена в ${Math.round(a.price / e.hi)} раз выше оценки`;
  return base;
}

function adminCard(a: any, title: string) {
  return [
    `<b>${title}</b>`,
    `<b>${h(plateText(a))}</b> — ${money(a.price)}`,
    estLine(a),
    a.city ? `Город: ${h(a.city)}` : "",
    a.descr ? `Описание: ${h(a.descr)}` : "",
    `Продавец: ${h(a.seller_name)}${a.seller_username ? " @" + h(a.seller_username) : ""} (ID ${a.seller_tg_id})`,
    a.wa ? `WhatsApp: +${h(a.wa)}` : "",
    `Объявление №${a.id}`,
  ].filter(Boolean).join("\n");
}

async function notifySeller(a: any, text: string) {
  try {
    await tg("sendMessage", { chat_id: a.seller_tg_id, text, parse_mode: "HTML" });
  } catch { /* продавец мог не запускать бота */ }
}

// ---------- режим оплаты ----------
async function getMode(): Promise<string> {
  try {
    const rows = await db("settings?select=value&key=eq.pay_mode");
    const v = rows[0]?.value;
    return v === "free" || v === "paid" ? v : "auto";
  } catch { return "auto"; } // таблицы ещё нет — ведём себя как «Авто»
}
async function setMode(mode: string) {
  await db("settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ key: "pay_mode", value: mode }),
  });
}
async function countPlaced(): Promise<number> {
  const rows = await db("listings?select=id&status=in.(pending,active,sold)");
  return rows.length;
}
async function getPricing() {
  const [mode, count] = await Promise.all([getMode(), countPlaced()]);
  const free = mode === "free" || (mode === "auto" && count < FREE_LIMIT);
  return { mode, count, free, left: mode === "auto" ? Math.max(0, FREE_LIMIT - count) : null, limit: FREE_LIMIT, tiers: TIERS.map((t) => ({ upTo: Number.isFinite(t.upTo) ? t.upTo : null, price: t.price })), paymentsReady: false };
}

// ---------- действия мини-приложения ----------
const SELLER_FIELDS = "id,l1,d,l2,r,price,city,descr,wa,status,created_at,approved_at";

async function handleApp(body: any) {
  const user = await verifyInitData(String(body.initData || ""));
  if (!user) return json({ error: "Откройте приложение через бота в Telegram." }, 401);
  const uid = user.id;

  switch (body.action) {
    case "create": {
      const l1 = String(body.l1 || "").toUpperCase();
      const d = String(body.d || "");
      const l2 = String(body.l2 || "").toUpperCase();
      const r = String(body.r || "");
      const price = Math.round(Number(body.price));
      const city = String(body.city || "").trim().slice(0, 60);
      const descr = String(body.descr || "").trim().slice(0, 500);
      const wa = String(body.wa || "").replace(/\D/g, "").replace(/^8/, "7");

      if (!new RegExp(`^[${LETTERS}]$`).test(l1) || !new RegExp(`^[${LETTERS}]{2}$`).test(l2))
        return json({ error: "Проверьте буквы номера." }, 400);
      if (!/^\d{3}$/.test(d) || d === "000") return json({ error: "Нужно три цифры номера." }, 400);
      if (!/^\d{2,3}$/.test(r)) return json({ error: "Код региона: 2 или 3 цифры." }, 400);
      if (!Number.isFinite(price) || price < 0 || price > 1e10) return json({ error: "Проверьте цену." }, 400);
      if (wa && !/^7\d{10}$/.test(wa)) return json({ error: "Номер WhatsApp: 11 цифр, начиная с 7." }, 400);
      if (!user.username && !wa)
        return json({ error: "У вас нет @username в Telegram. Укажите номер WhatsApp, чтобы покупатели могли связаться." }, 400);

      const pricing = await getPricing();
      if (!pricing.free)
        return json({ error: "Бесплатные места закончились. Платное размещение откроется в ближайшее время." }, 402);

      const pending = await db(`listings?select=id&seller_tg_id=eq.${uid}&status=eq.pending`);
      if (pending.length >= MAX_PENDING)
        return json({ error: "У вас уже есть объявления на проверке. Дождитесь решения модератора." }, 429);

      const [row] = await db("listings", {
        method: "POST",
        body: JSON.stringify({
          l1, d, l2, r, price, city, descr, wa: wa || null,
          seller_tg_id: uid,
          seller_name: [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 60) || "Продавец",
          seller_username: user.username || null,
        }),
      });

      if (ADMIN) {
        await tg("sendMessage", {
          chat_id: ADMIN,
          text: adminCard(row, "Новое объявление на проверку"),
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[
            { text: "✅ Одобрить", callback_data: `ok:${row.id}` },
            { text: "❌ Отклонить", callback_data: `no:${row.id}` },
          ]] },
        });
      }
      if (ADMIN && pricing.mode === "auto" && pricing.count + 1 === FREE_LIMIT) {
        await tg("sendMessage", { chat_id: ADMIN, text: `🎉 Размещено ${FREE_LIMIT} объявлений. В режиме «Авто» размещение теперь платное. Изменить: /paid` });
      }
      return json({ ok: true, id: row.id });
    }

    case "my": {
      const rows = await db(`listings?select=${SELLER_FIELDS}&seller_tg_id=eq.${uid}&status=neq.removed&order=created_at.desc`);
      return json({ items: rows });
    }

    case "sold":
    case "remove": {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ error: "Нет такого объявления." }, 400);
      const status = body.action === "sold" ? "sold" : "removed";
      const rows = await db(`listings?id=eq.${id}&seller_tg_id=eq.${uid}&status=in.(pending,active)`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      if (!rows.length) return json({ error: "Объявление не найдено или уже снято." }, 404);
      return json({ ok: true });
    }

    case "pricing":
      return json(await getPricing());

    case "whoami":
      return json({ admin: isAdmin(uid) });

    case "admin_remove": {
      if (!isAdmin(uid)) return json({ error: "Нет доступа." }, 403);
      const a = await adminRemove(Number(body.id));
      if (!a) return json({ error: "Объявление не найдено или уже снято." }, 404);
      return json({ ok: true });
    }

    case "report": {
      const id = Number(body.id);
      const reason = String(body.reason || "").trim().slice(0, 300);
      const [a] = await db(`listings?select=*&id=eq.${id}&status=eq.active`);
      if (!a) return json({ error: "Объявление не найдено." }, 404);
      if (ADMIN) {
        await tg("sendMessage", {
          chat_id: ADMIN,
          text: adminCard(a, "⚠️ Жалоба на объявление") +
            `\n\nОт: ${h(user.first_name)}${user.username ? " @" + h(user.username) : ""} (ID ${uid})` +
            (reason ? `\nПричина: ${h(reason)}` : ""),
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🗑 Снять объявление", callback_data: `rm:${a.id}` }]] },
        });
      }
      return json({ ok: true });
    }
  }
  return json({ error: "Неизвестное действие." }, 400);
}

// ---------- модерация ----------
async function adminRemove(id: number) {
  if (!Number.isInteger(id)) return null;
  const rows = await db(`listings?id=eq.${id}&status=in.(pending,active)`, { method: "PATCH", body: JSON.stringify({ status: "removed" }) });
  const a = rows[0];
  if (a) await notifySeller(a, `Объявление <b>${h(plateText(a))}</b> снято модератором.`);
  return a || null;
}

async function setAdminCommands() {
  if (!ADMIN) return null;
  return tg("setMyCommands", { commands: ADMIN_COMMANDS, scope: { type: "chat", chat_id: Number(ADMIN) } });
}

const ADMIN_HELP = [
  "<b>Вы модератор Номерка</b>",
  "",
  "/pending — объявления на проверке, с кнопками «Одобрить / Отклонить»",
  "/list — последние 10 опубликованных, у каждого кнопка «Снять»",
  "/del 15 — снять объявление №15 (номер виден в карточке объявления)",
  "/stats — сколько объявлений в каждом статусе",
  "/paid — режим оплаты: авто (первые 100 бесплатно), всегда бесплатно или платно",
  "",
  "В самом приложении у вас в каждом объявлении есть кнопка «Снять (модератор)».",
].join("\n");

async function handleAdminCommand(chat: number, text: string) {
  const [cmd, arg] = text.split(/\s+/);
  const c = cmd.split("@")[0].toLowerCase();
  if (c === "/admin") {
    await setAdminCommands();
    await tg("sendMessage", { chat_id: chat, text: ADMIN_HELP, parse_mode: "HTML" });
    return true;
  }
  if (c === "/pending") {
    const rows = await db("listings?select=*&status=eq.pending&order=created_at.asc&limit=10");
    if (!rows.length) { await tg("sendMessage", { chat_id: chat, text: "На проверке ничего нет 👌" }); return true; }
    for (const a of rows) {
      await tg("sendMessage", {
        chat_id: chat, text: adminCard(a, "На проверке"), parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ Одобрить", callback_data: `ok:${a.id}` }, { text: "❌ Отклонить", callback_data: `no:${a.id}` }]] },
      });
    }
    return true;
  }
  if (c === "/list") {
    const rows = await db("listings?select=*&status=eq.active&order=approved_at.desc.nullslast&limit=10");
    if (!rows.length) { await tg("sendMessage", { chat_id: chat, text: "Опубликованных объявлений пока нет." }); return true; }
    for (const a of rows) {
      await tg("sendMessage", {
        chat_id: chat, text: adminCard(a, "Опубликовано"), parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🗑 Снять", callback_data: `rm:${a.id}` }]] },
      });
    }
    return true;
  }
  if (c === "/del") {
    const id = Number(arg);
    if (!Number.isInteger(id)) { await tg("sendMessage", { chat_id: chat, text: "Укажите номер объявления, например: /del 15" }); return true; }
    const a = await adminRemove(id);
    await tg("sendMessage", { chat_id: chat, text: a ? `🗑 Снято: №${id} ${plateText(a)}` : `Объявление №${id} не найдено или уже снято.` });
    return true;
  }
  if (c === "/paid") {
    const p = await getPricing();
    await tg("sendMessage", {
      chat_id: chat, parse_mode: "HTML",
      text: `<b>Режим оплаты</b>\nСейчас: ${MODE_LABEL[p.mode]}\nРазмещено объявлений: ${p.count}\nНовые объявления сейчас: <b>${p.free ? "бесплатно" : "платно"}</b>\n\nВыберите режим:`,
      reply_markup: { inline_keyboard: [
        [{ text: (p.mode === "auto" ? "● " : "") + `Авто (до ${FREE_LIMIT} бесплатно)`, callback_data: "mode:auto" }],
        [{ text: (p.mode === "free" ? "● " : "") + "Всегда бесплатно", callback_data: "mode:free" }],
        [{ text: (p.mode === "paid" ? "● " : "") + "Платно сейчас", callback_data: "mode:paid" }],
      ] },
    });
    return true;
  }
  if (c === "/stats") {
    const rows: { status: string }[] = await db("listings?select=status");
    const n = (st: string) => rows.filter((r) => r.status === st).length;
    await tg("sendMessage", {
      chat_id: chat, parse_mode: "HTML",
      text: `<b>Статистика</b>\nОпубликовано: ${n("active")}\nНа проверке: ${n("pending")}\nПродано: ${n("sold")}\nОтклонено: ${n("rejected")}\nСнято: ${n("removed")}\nВсего: ${rows.length}`,
    });
    return true;
  }
  return false;
}

// ---------- вебхук бота ----------
async function handleBot(update: any) {
  const msg = update.message;
  if (msg?.text) {
    const chat = msg.chat.id;
    const text: string = msg.text.trim();
    if (isAdmin(msg.from?.id) && text.startsWith("/") && await handleAdminCommand(chat, text)) return;
    if (text.startsWith("/id")) {
      await tg("sendMessage", { chat_id: chat, text: `Ваш Telegram ID: <code>${msg.from.id}</code>`, parse_mode: "HTML" });
    } else if (text.startsWith("/start")) {
      await tg("sendMessage", {
        chat_id: chat,
        text: "Номерок — объявления о продаже красивых автономеров.\n\nСмотрите номера, связывайтесь с продавцами напрямую или разместите свой.",
        reply_markup: { inline_keyboard: [[{ text: "Открыть Номерок", web_app: { url: APP_URL } }]] },
      });
      if (isAdmin(msg.from?.id)) {
        await setAdminCommands();
        await tg("sendMessage", { chat_id: chat, text: ADMIN_HELP, parse_mode: "HTML" });
      }
    }
    return;
  }

  const cq = update.callback_query;
  if (cq) {
    if (!ADMIN || String(cq.from.id) !== ADMIN) {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Нет доступа" });
      return;
    }
    const [act, idStr] = String(cq.data || "").split(":");
    if (act === "mode" && ["auto", "free", "paid"].includes(idStr)) {
      try {
        await setMode(idStr);
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Сохранено" });
        if (cq.message) await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `✅ Режим оплаты: ${MODE_LABEL[idStr]}` });
      } catch {
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Не получилось. Создайте таблицу settings (файл 002_settings.sql).", show_alert: true });
      }
      return;
    }
    const id = Number(idStr);
    let patch: Record<string, unknown> | null = null;
    let from = "";
    let label = "";
    if (act === "ok") { patch = { status: "active", approved_at: new Date().toISOString() }; from = "pending"; label = "✅ Одобрено"; }
    if (act === "no") { patch = { status: "rejected" }; from = "pending"; label = "❌ Отклонено"; }
    if (act === "rm") { patch = { status: "removed" }; from = "rm"; label = "🗑 Снято"; }
    if (!patch || !Number.isInteger(id)) {
      await tg("answerCallbackQuery", { callback_query_id: cq.id });
      return;
    }
    const filter = from === "rm" ? "status=in.(pending,active)" : `status=eq.${from}`;
    const rows = await db(`listings?id=eq.${id}&${filter}`, { method: "PATCH", body: JSON.stringify(patch) });
    const a = rows[0];
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: a ? label : "Уже обработано" });
    if (cq.message) {
      await tg("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
      await tg("sendMessage", { chat_id: cq.message.chat.id, reply_to_message_id: cq.message.message_id, text: a ? `${label}: ${plateText(a)}` : "Это объявление уже обработано." });
    }
    if (a && act === "ok") await notifySeller(a, `✅ Ваше объявление <b>${h(plateText(a))}</b> опубликовано в Номерке.`);
    if (a && act === "no") await notifySeller(a, `❌ Объявление <b>${h(plateText(a))}</b> не прошло проверку.`);
    if (a && act === "rm") await notifySeller(a, `Объявление <b>${h(plateText(a))}</b> снято модератором.`);
  }
}

// ---------- точка входа ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!BOT) return json({ error: "Не задан секрет BOT_TOKEN." }, 500);
  const whSecret = (await sha256("wh:" + BOT)).slice(0, 48);

  try {
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("setup") === "1") {
      const hook = await tg("setWebhook", { url: FN_URL, secret_token: whSecret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
      const menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть", web_app: { url: APP_URL } } });
      const cmds = await tg("setMyCommands", { commands: [{ command: "start", description: "Открыть Номерок" }] });
      const adm = await setAdminCommands();
      return json({ webhook: hook.ok, menu_button: menu.ok, commands: cmds.ok, admin_set: Boolean(ADMIN), admin_commands: adm?.ok ?? false, details: { hook, menu } });
    }
    if (req.method !== "POST") return json({ ok: true, name: "nomerok" });

    // Запрос от Telegram
    if (req.headers.get("x-telegram-bot-api-secret-token")) {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== whSecret) return json({ error: "forbidden" }, 403);
      await handleBot(await req.json());
      return json({ ok: true });
    }
    // Запрос от мини-приложения
    return await handleApp(await req.json());
  } catch (e) {
    console.error(e);
    return json({ error: "Ошибка сервера. Попробуйте ещё раз." }, 500);
  }
});
