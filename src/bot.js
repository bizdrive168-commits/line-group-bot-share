// ตัวรับ event จาก LINE — คุยแชทส่วนตัว (1:1) เท่านั้น
// แยกเป็น factory รับ client / db / ai / media จากข้างนอก เทสจะได้ส่งของปลอมเข้ามาได้โดยไม่ต้องต่อ LINE จริง
const branding = require('./branding'); // อ่าน branding.BOT / SELF ตอนใช้ (ชื่อมาจาก LINE หลังบูต)
const { EMOJI, say } = branding;
const brief = require('./brief');
const owner = require('./owner');
const { guardNumbers } = require('./guard');

const MEDIA_TYPES = ['image', 'audio', 'video', 'file'];
const MAX_TEXT = 4900; // LINE รับข้อความละไม่เกิน 5,000 ตัวอักษร

// ข้อความที่ไม่ใช่ text → เก็บ placeholder ไว้ก่อน (สื่อจะถูกอ่านจริงแล้วเขียนทับ)
function placeholder(message) {
  switch (message.type) {
    case 'image':
      return '[รูป]';
    case 'sticker': {
      const kw = (message.keywords || []).slice(0, 3).join(' ');
      return kw ? `[สติกเกอร์: ${kw}]` : '[สติกเกอร์]';
    }
    case 'video':
      return '[วิดีโอ]';
    case 'audio':
      return '[เสียงพูด]';
    case 'file':
      return `[ไฟล์] ${message.fileName || ''}`.trim();
    case 'location':
      return `[ตำแหน่ง] ${[message.title, message.address].filter(Boolean).join(' ')}`.trim();
    default:
      return `[${message.type}]`;
  }
}

// เพดานข้อความต่อคนต่อวัน (กันค่า AI บาน) — DAILY_LIMIT=0 คือไม่จำกัด · เจ้าของไม่นับ
function dailyLimit(env = process.env) {
  const n = parseInt(env.DAILY_LIMIT ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}

function greeting(env = process.env) {
  return (
    String(env.BOT_GREETING || '').trim() ||
    `สวัสดีค่ะ ${branding.BOT}ยินดีที่ได้รู้จักนะคะ ${EMOJI}\nพิมพ์ถาม ส่งรูป หรือส่งข้อความเสียงมาได้เลยค่ะ`
  );
}

// ข้อความยาว (เช่น ดูหน้าที่ 8,000 ตัวอักษร) → ตัดเป็นหลายกล่อง ตัดตรงขึ้นบรรทัดใหม่ถ้าได้ · LINE รับได้ 5 กล่องต่อครั้ง
function chunk(text, size = MAX_TEXT, max = 5) {
  const parts = [];
  let rest = String(text);
  while (rest.length > size && parts.length < max - 1) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  parts.push(rest.slice(0, size));
  return parts;
}

function createBot({ client, db = require('./db'), ai = require('./ai'), media = require('./media'), env = process.env }) {
  const toMessages = (t) => chunk(say(t)).map((text) => ({ type: 'text', text }));

  // ตอบด้วย replyToken (ฟรี) — หมดอายุ/ใช้ไม่ได้ ค่อยถอยไป push (กินโควต้าฟรี 300/เดือน) จะได้ไม่เงียบหาย
  async function send(replyToken, to, t) {
    try {
      await client.replyMessage({ replyToken, messages: toMessages(t) });
      return 'reply';
    } catch (e) {
      console.error('[reply]', e.message);
      if (!to) return 'fail';
      try {
        await client.pushMessage({ to, messages: toMessages(t) });
        return 'push';
      } catch (e2) {
        console.error('[push]', e2.message);
        return 'fail';
      }
    }
  }

  // จำชื่อคนคุย — ยังไม่รู้ชื่อค่อยยิง API (ได้เฉพาะคนที่แอดบอทเป็นเพื่อน)
  async function rememberUser(userId) {
    if (await db.userName(userId)) return;
    let name = null;
    try {
      name = (await client.getProfile(userId))?.displayName || null;
    } catch {
      /* โปรไฟล์ไม่เปิด — ข้าม */
    }
    await db.upsertUser(userId, name);
  }

  async function leave(src) {
    try {
      if (src.type === 'room') await client.leaveRoom(src.roomId);
      else await client.leaveGroup(src.groupId);
    } catch (e) {
      console.error('[leave]', e.message);
    }
  }

  // จุดกำลังพิมพ์... ให้คนรู้ว่าบอทรับเรื่องแล้ว (สื่อ/โหมดเจ้าของใช้เวลานานกว่า)
  function loading(userId, seconds) {
    return Promise.resolve(client.showLoadingAnimation?.({ chatId: userId, loadingSeconds: seconds })).catch(() => {});
  }

  // เก็บข้อความ (สื่อ = อ่านก่อนแล้วเขียนทับ placeholder)
  async function store(userId, msg, lane) {
    if (msg.type === 'text') return db.logMessage(userId, 'user', msg.id, 'text', msg.text, lane);
    const rowId = await db.logMessage(userId, 'user', msg.id, msg.type, placeholder(msg), lane);
    if (MEDIA_TYPES.includes(msg.type)) {
      const read = await media.readMedia(msg);
      if (read) await db.updateMessageText(rowId, read);
    }
    return rowId;
  }

  // ---------- เจ้าของ ----------
  async function ownerTurn(event, userId, msg, text) {
    if (text) {
      const cmd = await owner.ownerCommand(userId, text, db);
      if (cmd) {
        await send(event.replyToken, userId, cmd);
        return 'owner-command';
      }
    }
    await loading(userId, 60);
    await store(userId, msg, 'owner');
    let out;
    try {
      const history = await db.recentMessages(userId, 30, 'owner');
      const briefText = (await brief.current(db)).TEXT;
      const draftText = (await db.getPendingBrief(userId))?.text || ''; // สั่งแก้ต่อจากร่างที่ยังไม่ยืนยัน
      const report = await owner.buildReport(db);
      const { reply, newBrief } = await ai.ownerReply(history, { name: await db.userName(userId), briefText, draftText, report });
      // เจ้าของก็ต้องไม่ได้เบอร์/เลขบัญชีที่ AI แต่ง (เช็คเฉพาะคำตอบ ส่วนจุดเปลี่ยนในคำสั่งโค้ดคิดเอง)
      out = guardNumbers(reply, [briefText, draftText, report, ...history.map((r) => r.text)]).text;
      out = out || `${branding.SELF}ยังตอบเรื่องนี้ไม่ได้ค่ะ ลองถามอีกแบบดูนะคะ`;
      if (newBrief) out = await owner.proposeBrief(userId, out, newBrief, db);
    } catch (e) {
      console.error('[owner-ai]', e.message);
      await send(event.replyToken, userId, `ขอโทษนะคะ ระบบ${branding.SELF}สะดุดนิดหน่อย ลองพิมพ์ใหม่อีกทีได้เลยค่ะ 🙏`);
      return 'error';
    }
    await db.logMessage(userId, 'bot', null, 'text', say(out), 'owner');
    await send(event.replyToken, userId, out);
    return 'owner-answered';
  }

  async function handleEvent(event) {
    const src = event.source || {};

    // --- กลุ่ม / ห้องรวม: บอทนี้คุยส่วนตัวเท่านั้น บอกสั้นๆ แล้วออก ---
    if (src.type === 'group' || src.type === 'room') {
      if (event.type === 'join') {
        await client
          .replyMessage({
            replyToken: event.replyToken,
            messages: toMessages(`${branding.BOT}คุยได้เฉพาะแชทส่วนตัวนะคะ แอดเพื่อนแล้วทักมาได้เลยค่ะ ${EMOJI}`),
          })
          .catch(() => {});
      }
      if (event.type === 'join' || event.type === 'message') {
        console.log(`[group] ไม่รับงานในกลุ่ม — ออกจาก ${src.groupId || src.roomId}`);
        await leave(src);
        return 'left';
      }
      return 'ignored';
    }

    const userId = src.userId;
    if (!userId) return 'ignored';

    // --- แอดเพื่อน (หรือปลดบล็อก) → ทักทาย ---
    if (event.type === 'follow') {
      await rememberUser(userId);
      const hi = greeting(env);
      await db.logMessage(userId, 'bot', null, 'text', say(hi));
      await send(event.replyToken, null, hi);
      return 'greeted';
    }

    // --- คนกด unsend → ลบตาม ---
    if (event.type === 'unsend' && event.unsend?.messageId) {
      await db.deleteByLineMsgId(event.unsend.messageId);
      return 'unsent';
    }

    if (event.type !== 'message') return 'ignored';
    const msg = event.message;
    const text = msg.type === 'text' ? msg.text.trim() : '';
    await rememberUser(userId);

    // --- พิมพ์รหัสเจ้าของถูก → เป็นเจ้าของ (ไม่เก็บรหัสลงฐานข้อมูล ไม่ส่งให้ AI) ---
    if (text && owner.isOwnerCode(text, env)) {
      await db.addOwner(userId);
      console.log(`[owner] เพิ่มเจ้าของ ${userId}`);
      await send(event.replyToken, userId, await owner.welcomeText(db)); // ยังไม่มีหน้าที่ = ชวนเล่าว่าอยากให้ทำอะไร
      return 'owner-added';
    }
    const mode = await db.ownerMode(userId); // null = ลูกค้า · owner · customer (เจ้าของทดลองคุยแบบลูกค้า)
    if (mode && text === 'กลับโหมดเจ้าของ') {
      await db.setOwnerMode(userId, 'owner');
      await send(event.replyToken, userId, await owner.welcomeText(db, false));
      return 'owner-mode';
    }
    if (mode === 'owner') return ownerTurn(event, userId, msg, text);

    // --- เพดานต่อวัน: ครบแล้วตอบสั้นๆ ไม่เรียก AI (เจ้าของไม่นับ) ---
    const limit = dailyLimit(env);
    if (!mode && limit && (await db.userMessagesToday(userId)) >= limit) {
      await send(event.replyToken, null, `วันนี้คุยกับ${branding.SELF}ครบ ${limit} ข้อความแล้วค่ะ พรุ่งนี้ทักมาใหม่ได้เลยนะคะ 🙏`);
      return 'limit';
    }

    await loading(userId, MEDIA_TYPES.includes(msg.type) ? 60 : 20);
    await store(userId, msg, 'chat');

    // --- ให้ AI ตอบจากคำสั่งประจำตัว + บทสนทนาที่ผ่านมา ---
    const history = await db.recentMessages(userId);
    const briefText = (await brief.current(db)).TEXT;
    let answer;
    try {
      answer = await ai.chatReply(history, { name: await db.userName(userId), briefText });
    } catch (e) {
      console.error('[ai]', e.message);
      await send(event.replyToken, userId, `ขอโทษนะคะ ระบบ${branding.SELF}สะดุดนิดหน่อย ลองพิมพ์ใหม่อีกทีได้เลยค่ะ 🙏`);
      return 'error';
    }
    if (!answer) answer = `ขอโทษค่ะ ${branding.SELF}ยังตอบเรื่องนี้ไม่ได้ ลองพิมพ์อีกแบบดูนะคะ`;
    // ด่านก่อนถึงลูกค้า: ช่อง 〔...〕 ที่ยังไม่กรอก + เลขบัญชี/เบอร์ที่ไม่มีอยู่จริงในข้อมูล
    const guarded = guardNumbers(brief.scrubPlaceholders(answer), [briefText, ...history.map((r) => r.text)]);
    if (guarded.removed.length) console.warn(`[guard] ตัดตัวเลขที่ไม่มีในข้อมูลออก: ${guarded.removed.join(', ')}`);
    const out = say(guarded.text);
    await db.logMessage(userId, 'bot', null, 'text', out);
    await send(event.replyToken, userId, out);
    return 'answered';
  }

  return { handleEvent };
}

module.exports = { createBot, placeholder, dailyLimit, greeting, chunk };
