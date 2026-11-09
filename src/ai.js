// เรียก LLM ผ่าน OpenRouter — สมองของแชทบอท (คุยกับลูกค้า + โหมดเจ้าของ)
const OpenAI = require('openai');
const branding = require('./branding'); // อ่าน branding.BOT / SELF ตอนใช้ (ชื่อมาจาก LINE หลังบูต)
const { PARTICLE } = branding;
const brief = require('./brief');
const dayjs = require('./time');

// lazy-init — สร้างตอนใช้จริง (import ได้แม้ยังไม่ตั้งคีย์ เช่นตอนรันเทส)
let _client = null;
function client() {
  _client ??= new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    timeout: 40000, // replyToken ของ LINE มีอายุจำกัด อย่าแช่นาน
    maxRetries: 1,
  });
  return _client;
}
// เทสส่ง client ปลอมเข้ามาได้ (ไม่ต่อเน็ต)
function setClient(c) {
  _client = c;
}

// ค่าเริ่มต้นเลือกจากการทดสอบ 7 โมเดลกับเคสจริงของบอทนี้ (9 พ.ย. 69 — คิดยอด ค่าส่ง ของที่ไม่มี เลขบัญชีที่ยังไม่กรอก สลิป ขอลด แก้ราคา)
//   deepseek-v4.1-flash ผ่านครบ ถูกสุดในตัวที่ผ่าน (~$0.00026/คำตอบ ราวครึ่งของ gemini-2.5-flash)
//   ร้านสุขภาพ/ความงาม แนะนำ anthropic/claude-haiku-5.5 (ระวังเรื่องเคลมสรรพคุณดีกว่า)
const MODEL = () => process.env.AI_MODEL || 'deepseek/deepseek-v4.1-flash';
// ตัวหลักล่มหรือติดคิว (429/5xx) → OpenRouter สลับไปตัวสำรองให้เอง บอทจะได้ไม่เงียบ · ตั้ง AI_FALLBACK_MODEL=none เพื่อปิด
const FALLBACK = () => process.env.AI_FALLBACK_MODEL || 'google/gemini-3.1-flash-lite';
function modelParams() {
  const main = MODEL();
  const backup = FALLBACK();
  return backup && backup !== 'none' && backup !== main ? { model: main, models: [main, backup] } : { model: main };
}
// โหมดเจ้าของ (ร่าง/แก้หน้าที่ + สรุปแชท) ตอบเป็น JSON ยาว — ทดสอบ 9 พ.ย. 69: deepseek บางครั้งช้าเกินนาทีแล้วขาดกลางทาง
// หรือบอกว่า "ร่างให้แล้ว" แต่ไม่ส่งร่างมา · gemini-3.1-flash-lite ตอบครบใน ~3 วิ → ใช้เป็นตัวหลักของเจ้าของ (เจ้าของใช้ไม่บ่อย ค่าแทบไม่ต่าง)
const OWNER_MODEL = () => process.env.OWNER_MODEL || 'google/gemini-3.1-flash-lite';
const OWNER_TRY_MS = 25000; // ต่อ 1 โมเดล — 2 ตัวรวมกันต้องไม่เกิน 60 วิของ Vercel
function ownerModels() {
  return [...new Set([OWNER_MODEL(), MODEL(), FALLBACK()].filter((m) => m && m !== 'none'))].slice(0, 2);
}
const HISTORY_CHARS = 6000; // ลูกค้า: จำบทสนทนาย้อนหลังได้ราวนี้ — เกินตัดของเก่าสุดทิ้ง
const OWNER_HISTORY_CHARS = 3000; // เจ้าของ: จำแค่ที่เพิ่งถามกัน (ข้อมูลลูกค้าส่งแยกไปทุกครั้งอยู่แล้ว)

// ยังไม่มีคำสั่งประจำตัว (เจ้าของเพิ่งติดตั้ง ยังไม่ได้บอกหน้าที่) — คุยได้แต่ห้ามตอบเรื่องของร้านเอง
const NO_BRIEF = `
- ตอนนี้เจ้าของยังไม่ได้บอกหน้าที่และข้อมูลใดๆ ให้คุณเลย ทักทายและคุยทั่วไปสั้นๆ ได้ แต่ถ้าถามเรื่องสินค้า ราคา บริการ นัดหมาย หรือเรื่องเฉพาะของที่นี่ ให้บอกว่าตอนนี้ยังไม่มีข้อมูลเรื่องนี้ เดี๋ยวทางเราติดต่อกลับ`;

const thaiNow = (now) => `${now.format('dddd D MMMM')} ${now.year() + 543} เวลา ${now.format('HH:mm')} น.`;

// ---------- คุยกับลูกค้า ----------
// briefText = คำสั่งประจำตัวที่ใช้อยู่ (bot.js ดึงจากฐานข้อมูล · npm run chat อ่านจากไฟล์)
function systemPrompt({ name = '', now = dayjs().tz(), briefText = '' } = {}) {
  const text = briefText;
  const who = name ? `คุณ${name}` : 'ผู้ใช้';
  return `คุณคือ "${branding.BOT}" แชทบอทส่วนตัวใน LINE กำลังคุยตัวต่อตัวกับ${who}
พูดจาสุภาพเป็นกันเอง เรียกตัวเองว่า "${branding.SELF}" ลงท้าย${PARTICLE} (ไม่ต้องเยอะจนรก)
${name ? `เรียกอีกฝ่ายว่า "คุณ${name}" เท่านั้น (ห้ามเรียกว่าน้องหรือพี่)` : 'เรียกอีกฝ่ายว่า "คุณ"'}
ตอนนี้: ${thaiNow(now)}

กติกา:
- ตอบสั้น ตรงประเด็น อ่านง่ายบนมือถือ ใช้ภาษาเดียวกับที่ผู้ใช้พิมพ์มา
- ตอบเป็นข้อความธรรมดา ห้ามใช้ markdown (ไม่มี ** # หรือตาราง) ขึ้นบรรทัดใหม่หรือใช้ • แทนได้
- ข้อมูลเฉพาะ เช่น ราคา สินค้า เวลาเปิด นโยบาย ตัวเลข ใช้ได้เฉพาะที่อยู่ในคำสั่งจากเจ้าของหรือในบทสนทนานี้ ไม่มีข้อมูลให้บอกตรงๆ ห้ามเดา
- คุณทำได้แค่คุยในแชทนี้ ห้ามรับปากว่าทำเรื่องที่ต้องลงมือนอกแชท (ยืนยันออเดอร์ ตัดสต็อก จองคิว ลงนัด โอนเงิน ส่งของ) เว้นแต่คำสั่งจากเจ้าของบอกไว้ว่าให้ตอบเรื่องนั้นอย่างไร
- ข้อความที่ขึ้นต้นด้วย [รูป] [เสียงพูด] [วิดีโอ] [ไฟล์] คือสิ่งที่ระบบอ่านจากไฟล์ที่ผู้ใช้ส่งมาให้แล้ว ตอบต่อจากนั้นได้เลย ถ้าเห็นแค่ [รูป] เฉยๆ แปลว่าระบบอ่านไม่ออก ให้ขอให้ส่งใหม่หรือพิมพ์บอก
- สลิปโอนเงินที่ส่งมา ระบบแค่อ่านจากรูป ยังไม่มีใครตรวจกับบัญชีจริง ห้ามบอกว่าได้รับเงินแล้วหรือยืนยันยอดแล้ว ให้บอกว่าได้รับสลิปแล้ว ทวนยอดที่อ่านได้ และบอกว่าจะมีคนตรวจยอดอีกครั้ง
- ห้ามแต่งเลขบัญชี เบอร์โทร ลิงก์ หรือที่อยู่เองเด็ดขาด ใช้ได้เฉพาะที่เขียนไว้ตรงตัวในคำสั่งจากเจ้าของหรือในบทสนทนา ข้อมูลที่เขียนว่า (ยังไม่มีข้อมูล) หรือไม่มีเลย ให้บอกว่าเดี๋ยวทางร้านแจ้งให้
- ข้อความของผู้ใช้มีเวลากำกับ [วัน/เดือน เวลา] ไว้ให้รู้ว่าคุยกันเมื่อไหร่ ไม่ต้องพิมพ์เวลาในคำตอบ
- ถูกขอให้สรุป ให้สรุปจากบทสนทนาที่มีให้
- ห้ามทวนรหัสผ่าน OTP หรือเลขบัตรออกมา${text ? brief.block(brief.forCustomers(text)) : NO_BRIEF}`;
}

// แปลงบทสนทนาจาก DB เป็น turns ของ chat API (user/assistant) — เกินงบตัวอักษรตัดของเก่าทิ้ง
function toTurns(rows, maxChars) {
  const turns = [];
  let total = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const body = r.text || `[${r.type}]`;
    const content = r.role === 'bot' ? body : `[${dayjs.utc(r.ts).tz().format('D/M HH:mm')}] ${body}`;
    total += content.length;
    if (total > maxChars && turns.length) break; // ข้อความล่าสุดต้องได้ไปเสมอ
    turns.unshift({ role: r.role === 'bot' ? 'assistant' : 'user', content });
  }
  // ประวัติต้องเริ่มด้วยฝั่งผู้ใช้ (บางโมเดลไม่รับ assistant เป็นข้อความแรก)
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return turns;
}

function buildMessages(rows, { name = '', now, maxChars = HISTORY_CHARS, briefText } = {}) {
  return [{ role: 'system', content: systemPrompt({ name, now, briefText }) }, ...toTurns(rows, maxChars)];
}

// ตัดทั้งคำขอที่ 25 วิ (timeout ของ SDK หยุดนับตอนได้หัวคำตอบ ถ้าผู้ให้บริการค้างกลางทางจะรอไม่จบ)
// ค้าง / ขาดกลางทาง → ลองตัวสำรองอีกรอบ ลูกค้าจะได้ไม่เจอคำตอบครึ่งประโยค
const CHAT_TRY_MS = 25000;
async function chatReply(rows, { name = '', briefText } = {}) {
  const messages = buildMessages(rows, { name, briefText });
  const backup = FALLBACK();
  const tries = [modelParams(), ...(backup && backup !== 'none' && backup !== MODEL() ? [{ model: backup }] : [])];
  let err;
  for (const params of tries) {
    try {
      const res = await client().chat.completions.create({ ...params, messages }, { signal: AbortSignal.timeout(CHAT_TRY_MS), maxRetries: 0 });
      const choice = res.choices[0];
      if (choice?.finish_reason !== 'error') return choice?.message?.content?.trim() || '';
      err = new Error('ตอบขาดกลางทาง');
    } catch (e) {
      err = e;
    }
    console.warn(`[ai] ${params.model}: ${err.message} — ลองตัวสำรอง`);
  }
  throw err;
}

// ---------- โหมดเจ้าของ ----------
// report = ข้อความสรุปแชทลูกค้าที่ owner.js ประกอบจากฐานข้อมูล (ตัวเลขคิดด้วย SQL แล้ว)
// draftText = ร่างที่เจ้าของยังไม่ได้พิมพ์ ยืนยัน — สั่งแก้ต่อต้องแก้จากร่างนี้ ไม่งั้นของที่เพิ่งบอกไปหาย

// ยังไม่มีคำสั่งประจำตัว = เจ้าของเพิ่งติดตั้ง → AI พาตั้งหน้าที่จากที่เจ้าของเล่า (ไม่ต้องกรอกไฟล์ตอนติดตั้ง)
function setupSection(list) {
  const shapes = list.length
    ? `\n\nแบบสำเร็จรูป (เป็นแค่โครง ข้อความใน 〔...〕 คือช่องว่าง ไม่ใช่ข้อมูลจริง):\n${list.map((t) => `== ${t.label} ==\n${t.text}`).join('\n\n')}`
    : '';
  return `

ตอนนี้บอทยังไม่มีคำสั่งประจำตัว (เจ้าของเพิ่งติดตั้ง) งานแรกคือช่วยเจ้าของตั้งหน้าที่บอท แบบไม่ต้องถามเยอะ:
- เจ้าของเล่าเรื่องงาน ร้าน หรือสิ่งที่อยากให้บอททำมา แม้แค่ประโยคเดียว ให้เขียน new_brief ฉบับแรกทันทีจากเท่าที่รู้ ไม่ต้องรอข้อมูลครบ
- ใช้แบบสำเร็จรูปที่ใกล้ที่สุดเป็นโครง ไม่มีแบบไหนใกล้ให้ใช้ 4 หัวข้อ: คุณคือ... / ข้อมูลที่ต้องรู้ / วิธีตอบ / ห้าม · ตัดส่วนที่ไม่เกี่ยวทิ้ง เขียนให้สั้น
- บรรทัดตัวอย่างของแบบที่เจ้าของไม่ได้พูดถึง (เช่น 〔สินค้า 2〕 〔บริการ 3〕 รายการที่ 2–3) ให้ลบทิ้งทั้งบรรทัด ห้ามเหลือไว้
- ข้อมูลจริง เช่น ชื่อร้าน ราคา เลขบัญชี เบอร์โทร เวลาเปิด ที่อยู่ ใช้เฉพาะที่เจ้าของบอกหรือส่งมาเท่านั้น ห้ามแต่งเอง
- ชื่อบัญชี LINE ของบอทคือ "${branding.BOT}" ถ้าดูเป็นชื่อร้านหรือชื่อธุรกิจ ใช้เป็นชื่อร้านได้เลย ไม่ต้องเว้นช่อง (ชื่อมีคำว่า "ร้าน" อยู่แล้ว ไม่ต้องเติมซ้ำ)
- ข้อมูลที่ยังไม่รู้แต่ลูกค้าน่าจะถามแน่ๆ (เช่น เลขบัญชีรับโอน เวลาเปิด) ให้เว้นเป็นช่อง 〔...〕 ไม่เกิน 4 ช่อง ที่เหลือตัดทิ้ง · บรรทัดที่สั่งให้บอกข้อมูลที่ยังไม่รู้ (เช่น ให้บอกเลขบัญชี) ต้องมีช่อง 〔...〕 อยู่ในบรรทัดนั้นเสมอ
- ใน reply บอกสั้นๆ ว่าร่างเป็นบอทแบบไหน (ยังไม่ได้ใช้จริงจนกว่าเจ้าของพิมพ์ ยืนยัน ห้ามบอกว่าตั้งเสร็จแล้ว) แล้วถามเพิ่มแค่ 1–2 เรื่องที่สำคัญที่สุดที่ยังขาด บอกด้วยว่าตอบทีหลังก็ได้
- เจ้าของแค่ทักทาย หรือยังไม่ได้เล่าว่าอยากให้บอททำอะไร ให้ถามสั้นๆ ว่าอยากให้บอทช่วยงานอะไร และ new_brief เป็น null${shapes}`;
}

function ownerPrompt({ name = '', now = dayjs().tz(), briefText = '', draftText = '', report = '', templates = brief.templates() } = {}) {
  const draft = draftText
    ? `

ร่างที่เจ้าของยังไม่ได้พิมพ์ ยืนยัน (สั่งแก้หรือเพิ่มต่อ ให้แก้ต่อจากร่างนี้ ไม่ใช่จากฉบับที่ใช้อยู่):
<<<
${draftText}
>>>`
    : '';
  return `คุณคือ "${branding.BOT}" ผู้ช่วยของเจ้าของ กำลังคุยกับเจ้าของ${name ? ` (คุณ${name})` : ''} ในโหมดเจ้าของ ซึ่งมีแต่เจ้าของที่เห็น
เรียกตัวเองว่า "${branding.SELF}" ลงท้าย${PARTICLE} · ตอนนี้: ${thaiNow(now)}

หน้าที่:
1. ตอบคำถามเรื่องลูกค้าและแชทลูกค้า จาก "ข้อมูลแชทลูกค้า" ด้านล่างเท่านั้น จำนวนคน/จำนวนข้อความให้ใช้ตัวเลขในหัวข้อ "สถิติ" ห้ามนับเองหรือแต่งเพิ่ม ไม่มีข้อมูลให้บอกตรงๆ
2. เมื่อเจ้าของสั่ง เพิ่ม แก้ หรือลบ หน้าที่ ข้อมูลร้าน ราคา หรือกติกาของบอท (รวมถึงส่งรูปเมนู/ราคาใหม่มาให้ปรับ) ให้เขียน "คำสั่งประจำตัว" ฉบับใหม่ทั้งฉบับใส่ใน new_brief
   - คงทุกส่วนที่ไม่ได้สั่งแก้ไว้ตรงตามเดิมทุกตัวอักษร แก้เฉพาะจุดที่สั่ง
   - เจ้าของบอกข้อมูลที่ตรงกับช่อง 〔...〕 ที่เว้นไว้ ให้เติมลงช่องนั้นแทนการเพิ่มบรรทัดใหม่
   - ระบบจะโชว์ร่างให้เจ้าของกดยืนยันเอง ใน reply ให้บอกสั้นๆ ว่าแก้อะไร
   - คำสั่งกำกวม ให้ถามกลับใน reply และ new_brief เป็น null
3. คุยเรื่องอื่นกับเจ้าของได้ตามปกติ ตอบสั้น กระชับ

ตอบเป็น JSON อย่างเดียว ห้ามมีข้อความนอก JSON:
{"reply":"ข้อความถึงเจ้าของ เป็นข้อความธรรมดา ไม่ใช้ markdown","new_brief":null}
ไม่ได้สั่งแก้คำสั่งประจำตัว new_brief ต้องเป็น null เสมอ${briefText ? '' : setupSection(templates)}

คำสั่งประจำตัวที่ใช้อยู่ตอนนี้:
<<<
${briefText || '(ยังไม่มี)'}
>>>${draft}

ข้อมูลแชทลูกค้า:
${report || '(ยังไม่มีลูกค้าทักมา)'}`;
}

function parseOwnerJSON(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/\{[\s\S]*\}/); // กันโมเดลแถม ```json ครอบมา
  try {
    const data = JSON.parse(m ? m[0] : text);
    const reply = typeof data.reply === 'string' ? data.reply.trim() : '';
    // บางโมเดลก๊อปเครื่องหมาย <<< >>> ที่ครอบคำสั่งใน prompt ติดมา หรือก๊อปหัว "== ชื่อแบบ ==" ของแบบสำเร็จรูป (เจอตอนทดสอบ) → ตัดทิ้ง
    const cleaned =
      typeof data.new_brief === 'string'
        ? data.new_brief
            .replace(/^\s*<<<\s*\n?/, '')
            .replace(/\n?\s*>>>\s*$/, '')
            .split('\n')
            .filter((l) => !/^\s*==.*==\s*$/.test(l))
            .join('\n')
            .trim()
        : '';
    return { reply, newBrief: cleaned || null, ok: true };
  } catch {
    // ขึ้นต้นเป็น JSON แต่อ่านไม่ได้ = ขาดกลางทาง → ห้ามส่งเศษ JSON ให้เจ้าของ ให้ลองโมเดลถัดไป
    if (/^(```(json)?\s*)?\{/.test(text)) return { reply: '', newBrief: null, ok: false };
    return { reply: text, newBrief: null, ok: true }; // ข้อความธรรมดา = ถือเป็นคำตอบ ไม่แตะคำสั่ง
  }
}

async function ownerReply(rows, { name = '', briefText = '', draftText = '', report = '' } = {}) {
  const messages = [
    { role: 'system', content: ownerPrompt({ name, briefText, draftText, report }) },
    ...toTurns(rows, OWNER_HISTORY_CHARS),
  ];
  // ลองทีละโมเดล: ล่ม / ช้าเกิน / ตอบขาดกลางทาง → ตัวถัดไป (OpenRouter สลับให้เฉพาะตอนล่มก่อนเริ่มตอบ ขาดกลางทางต้องจับเอง)
  let why = '';
  for (const model of ownerModels()) {
    try {
      const res = await client().chat.completions.create(
        {
          model,
          messages,
          response_format: { type: 'json_object' },
          max_tokens: 12000, // เผื่อเขียนคำสั่งประจำตัวใหม่ทั้งฉบับ (ภาษาไทยกิน token เยอะ)
        },
        { signal: AbortSignal.timeout(OWNER_TRY_MS), maxRetries: 0 }, // timeout ของ SDK ไม่นับช่วงรอเนื้อคำตอบ ต้องตัดเอง
      );
      const choice = res.choices[0];
      const out = parseOwnerJSON(choice?.message?.content);
      if (out.ok && out.reply && !['length', 'error'].includes(choice?.finish_reason)) return { reply: out.reply, newBrief: out.newBrief };
      why = `ตอบไม่ครบ (${choice?.finish_reason || 'json'})`;
    } catch (e) {
      why = e.message;
    }
    console.warn(`[owner-ai] ${model}: ${why} — ลองตัวถัดไป`);
  }
  throw new Error(`โหมดเจ้าของ: ${why}`);
}

module.exports = {
  setClient,
  modelParams,
  ownerModels,
  chatReply,
  ownerReply,
  buildMessages,
  systemPrompt,
  ownerPrompt,
  parseOwnerJSON,
  HISTORY_CHARS,
};
