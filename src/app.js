// แอป Express ตัวเดียว ใช้ได้ทั้ง 2 แบบ:
//   Railway / เครื่องตัวเอง → src/index.js เรียก app.listen()
//   Vercel                  → api/index.js ส่ง app ออกไปเป็น serverless function
const express = require('express');
const line = require('@line/bot-sdk');
const dayjs = require('./time');
const db = require('./db');
const { createBot } = require('./bot');
const branding = require('./branding');
const brief = require('./brief');
const { ownerCode, MIN_CODE } = require('./owner');

const ON_VERCEL = !!process.env.VERCEL;

// บน Vercel ฟังก์ชันจะถูกแช่แข็งทันทีที่ตอบ LINE — ต้องบอก waitUntil ให้รอทำงานเบื้องหลังจนเสร็จ
// บน Railway เซิร์ฟเวอร์รันตลอด ปล่อยทำต่อเฉยๆ ได้เลย
function background(promise) {
  if (ON_VERCEL) require('@vercel/functions').waitUntil(promise);
}

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
});

// ไม่ได้ตั้ง BOT_NAME → ใช้ชื่อ LINE Official Account (ไม่ต้องกรอกชื่อซ้ำตอนติดตั้ง) · อ่านไม่ได้ก็ใช้ชื่อสำรอง ไม่ล้ม
async function useLineName() {
  if (String(process.env.BOT_NAME || '').trim() || !process.env.LINE_CHANNEL_ACCESS_TOKEN) return;
  let timer;
  try {
    const slow = new Promise((_, no) => (timer = setTimeout(() => no(new Error('timeout')), 5000)));
    const info = await Promise.race([client.getBotInfo(), slow]);
    if (branding.useLineName(info?.displayName)) console.log(`[name] ใช้ชื่อจาก LINE OA: ${branding.BOT} (เรียกตัวเองว่า ${branding.SELF})`);
  } catch (e) {
    console.warn(`[name] อ่านชื่อ LINE OA ไม่ได้ (${e.message}) — ใช้ชื่อ "${branding.BOT}" ไปก่อน · ตั้ง BOT_NAME เองได้`);
  } finally {
    clearTimeout(timer);
  }
}

// เตรียมระบบครั้งเดียวต่อโปรเซส (Vercel = ต่อ cold start): สร้างตาราง + อ่าน brief.txt ว่าเปลี่ยนไหม
let started = null;
function startup() {
  started ??= (async () => {
    await Promise.all([db.init(), useLineName()]);
    const active = await brief.syncBoot(db);
    const missing = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'OPENROUTER_API_KEY'].filter((k) => !process.env[k]);
    if (missing.length) console.warn(`⚠️  ยังไม่ได้ตั้งค่า: ${missing.join(', ')} — บอทจะยังตอบแชทไม่ได้จนกว่าจะตั้งครบ ดูวิธีใน INSTALL.md`);
    console.log(
      active.SOURCE === 'none'
        ? `[brief] ยังไม่มีหน้าที่ — ${ownerCode() ? 'เจ้าของพิมพ์ OWNER_CODE หาบอทในแชท แล้วเล่าให้ฟังว่าอยากให้ทำอะไร' : 'ตั้ง OWNER_CODE เพื่อบอกหน้าที่ผ่านแชท LINE (หรือเขียน brief.txt)'}`
        : `[brief] ใช้คำสั่งประจำตัว${active.SOURCE === 'chat' ? 'ที่เจ้าของแก้ผ่านแชท' : 'จากไฟล์'} (${active.TEXT.length} ตัวอักษร)`,
    );
    if (!process.env.OWNER_CODE) console.log('[owner] ยังไม่ได้ตั้ง OWNER_CODE — ปิดโหมดเจ้าของ');
    else if (!ownerCode()) console.warn(`⚠️  OWNER_CODE สั้นเกิน (ต้อง ${MIN_CODE} ตัวขึ้นไป) — ปิดโหมดเจ้าของ`);
    else console.log('[owner] เปิดโหมดเจ้าของ — เจ้าของพิมพ์ OWNER_CODE หาบอท 1 ครั้ง');
    console.log(`[db] ${db.IS_FILE ? `ไฟล์ ${db.dbFile()}` : 'คลาวด์ (Turso)'}`);
    if (ON_VERCEL && db.IS_FILE) console.warn('⚠️  บน Vercel ต้องตั้ง DATABASE_URL (Turso) — ไฟล์ในเครื่องจะหายทุกครั้งที่ฟังก์ชันบูตใหม่');
    return active;
  })().catch((e) => {
    started = null; // บูตไม่ผ่าน (เช่น ต่อฐานข้อมูลไม่ได้) → รอบหน้าลองใหม่
    throw e;
  });
  return started;
}

const bot = createBot({ client });

const app = express();

// ---------- webhook ----------
// ทำทีละ event ตามลำดับ (คนพิมพ์รัวหลายข้อความ บอทจะได้ตอบเรียงถูก)
async function processEvents(events) {
  await startup();
  for (const event of events) {
    await bot.handleEvent(event).catch((e) => console.error('[event]', e.message));
  }
}
if (process.env.LINE_CHANNEL_SECRET) {
  app.post('/webhook', line.middleware({ channelSecret: process.env.LINE_CHANNEL_SECRET }), (req, res) => {
    const work = processEvents(req.body.events || []).catch((e) => console.error('[webhook]', e.message));
    background(work);
    res.sendStatus(200); // ตอบ LINE ก่อน ค่อยประมวลผล (กัน timeout)
  });
} else {
  app.post('/webhook', (_req, res) => res.status(503).send('LINE ยังไม่ได้ตั้งค่า — ดู INSTALL.md'));
}

// ลายเซ็นไม่ตรง = ไม่ได้มาจาก LINE (หรือ LINE_CHANNEL_SECRET ผิด) → ตอบ 401 สั้นๆ ไม่พ่น stack ยาวลง log
app.use((err, _req, res, next) => {
  if (err instanceof line.SignatureValidationFailed) {
    console.warn('[webhook] ลายเซ็นไม่ตรง — เช็ค LINE_CHANNEL_SECRET');
    return res.status(401).send('bad signature');
  }
  next(err);
});

// เช็คว่าบอทยังมีชีวิต + ต่อฐานข้อมูลได้ (ใช้ตอนติดตั้งเสร็จ)
app.get('/health', async (_req, res) => {
  try {
    await startup();
    res.json({ ok: true, db: db.IS_FILE ? 'file' : 'turso', host: ON_VERCEL ? 'vercel' : 'server' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/', (_req, res) => res.type('text/plain').send(`${branding.BOT} ทำงานอยู่ — ตั้ง Webhook URL ใน LINE เป็น <ที่อยู่นี้>/webhook`));

// ดาวน์โหลดไฟล์ฐานข้อมูลไว้สำรอง (bin/backup-db.sh เรียกทุกคืน) — ต้องมี ADMIN_KEY · ใช้ Turso ให้สำรองที่หน้าเว็บ Turso
app.get('/admin/backup', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).send('forbidden');
  if (!db.dbFile()) return res.status(501).send('ใช้ฐานข้อมูล Turso — สำรองข้อมูลได้ที่หน้าเว็บ turso.tech (ดู INSTALL.md)');
  await db.checkpoint();
  res.download(db.dbFile(), `chatbot-${dayjs().format('YYYY-MM-DD')}.db`);
});

module.exports = { app, startup, processEvents };
