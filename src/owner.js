// โหมดเจ้าของ — เจ้าของคุยกับบอทในแชทส่วนตัวของตัวเอง เพื่อดูแชทลูกค้า และแก้หน้าที่บอทผ่าน LINE
//
// เปิดใช้: ตั้ง OWNER_CODE (8 ตัวขึ้นไป) ใน .env แล้วเจ้าของพิมพ์รหัสนี้ส่งหาบอท 1 ครั้ง
// ลูกค้าทั่วไปไม่มีทางพิมพ์รหัสสุ่มยาวๆ ตรงเป๊ะ → ไม่ต้องมีคำสั่งพิเศษให้ลูกค้าเผลอชน
const crypto = require('crypto');
const dayjs = require('./time');
const branding = require('./branding');
const { EMOJI } = branding;
const brief = require('./brief');

const MIN_CODE = 8;

function ownerCode(env = process.env) {
  const code = String(env.OWNER_CODE || '').trim();
  return code.length >= MIN_CODE ? code : '';
}
// เทียบแบบเวลาคงที่ กันเดารหัสจากเวลาตอบ — เทียบ hash เพราะข้อความไทยยาวเท่ากันแต่จำนวนไบต์ไม่เท่า (timingSafeEqual จะล้ม)
const sha = (s) => crypto.createHash('sha256').update(s).digest();
function isOwnerCode(text, env = process.env) {
  const code = ownerCode(env);
  const got = String(text || '').trim();
  if (!code || got.length !== code.length) return false;
  return crypto.timingSafeEqual(sha(got), sha(code));
}

// ---------- รายงานแชทลูกค้า (ประกอบจากฐานข้อมูล ส่งให้ AI ทุกครั้งที่เจ้าของถาม) ----------
function customerLabel(c) {
  return c.name ? `คุณ${c.name}` : `ลูกค้าไม่ทราบชื่อ #${String(c.user_id).slice(-4)}`;
}
async function buildReport(db, { days = 7, maxChars = 24000, perCustomerChars = 4000 } = {}) {
  const since = dayjs().tz().startOf('day').subtract(days - 1, 'day').utc().format('YYYY-MM-DD HH:mm:ss');
  const customers = await db.customersSince(since);
  const todayCount = customers.filter((c) => c.today_msgs > 0).length;
  const todayMsgs = customers.reduce((s, c) => s + (c.today_msgs || 0), 0);
  const lines = [
    `สถิติ (คิดจากฐานข้อมูล ใช้ตัวเลขนี้เท่านั้น):`,
    `- วันนี้มีลูกค้าทัก ${todayCount} คน รวม ${todayMsgs} ข้อความ`,
    `- ${days} วันล่าสุด มีลูกค้าทัก ${customers.length} คน`,
    ...customers.map(
      (c) =>
        `- ${customerLabel(c)}: วันนี้ ${c.today_msgs} ข้อความ · ${days} วัน ${c.user_msgs} ข้อความ · ส่งรูป/ไฟล์/เสียง ${c.media} ชิ้น · ทักล่าสุด ${dayjs.utc(c.last_ts).tz().format('D/M HH:mm')}`,
    ),
    '',
    `บทสนทนา ${days} วันล่าสุด (ใหม่สุดอยู่บน):`,
  ];
  let total = lines.join('\n').length;
  let skipped = 0;
  for (const c of customers) {
    const rows = await db.messagesOfUserSince(c.user_id, since);
    // เก็บช่วงท้ายของแต่ละคน (สดกว่า) ไม่เกิน perCustomerChars
    const convo = [];
    let size = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const line = `[${dayjs.utc(r.ts).tz().format('D/M HH:mm')}] ${r.role === 'bot' ? 'บอท' : 'ลูกค้า'}: ${r.text || `[${r.type}]`}`;
      if (size + line.length > perCustomerChars && convo.length) break;
      convo.unshift(line);
      size += line.length + 1;
    }
    const blockText = `\n== ${customerLabel(c)} ==\n${convo.join('\n')}`;
    if (total + blockText.length > maxChars) {
      skipped++;
      continue;
    }
    lines.push(blockText);
    total += blockText.length;
  }
  if (skipped) lines.push(`\n(มีลูกค้าอีก ${skipped} คนที่ไม่ได้ใส่บทสนทนาเพราะยาวเกิน — มีแค่ในสถิติด้านบน)`);
  return lines.join('\n');
}

// ---------- จุดที่เปลี่ยนในคำสั่งประจำตัว (คิดด้วยโค้ด ไม่เชื่อคำบอกเล่าของ AI) ----------
function lineDiff(oldText, newText, maxLines = 20) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  // LCS ทีละบรรทัด — คำสั่งประจำตัวยาวไม่กี่ร้อยบรรทัด ตารางเล็กพอ
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const show = (l) => l.trim().replace(/^[-•]\s+/, ''); // ตัดขีดหน้าข้อ จะได้ไม่ขึ้น "− - ..." ซ้อนกัน
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || dp[i + 1][j] >= dp[i][j + 1])) {
      if (a[i].trim()) out.push(`− ${show(a[i])}`); // ลบของเก่าก่อน แล้วค่อยโชว์ของใหม่ อ่านง่ายกว่า
      i++;
    } else {
      if (b[j].trim()) out.push(`+ ${show(b[j])}`);
      j++;
    }
  }
  if (out.length > maxLines) return [...out.slice(0, maxLines), `(และอีก ${out.length - maxLines} บรรทัด)`];
  return out;
}

function menuText() {
  return `โหมดเจ้าของ ${EMOJI} (เห็นแค่เจ้าของ)

ถามเรื่องลูกค้าได้เลย เช่น
• วันนี้มีลูกค้าทักกี่คน ใครสั่งอะไรบ้าง
• ใครส่งสลิปมาบ้าง ยอดเท่าไหร่
• สรุปแชทคุณพลอย
• มีใครถามเรื่องที่${branding.BOT}ตอบไม่ได้บ้าง

แก้หน้าที่บอท: พิมพ์บอกได้เลย เช่น "แก้ราคาคุกกี้เป็น 130" หรือส่งรูปเมนูใหม่มา แล้วพิมพ์ ยืนยัน

คำสั่ง: ดูหน้าที่ · ย้อนกลับ · ทดลองเป็นลูกค้า · กลับโหมดเจ้าของ · เลิกเป็นเจ้าของ · เมนู`;
}

// เจ้าของเพิ่งติดตั้ง ยังไม่มีหน้าที่ → ชวนเล่าแบบคุยกัน ไม่ต้องกรอกฟอร์ม (AI ร่างให้ โชว์ให้ดูก่อนใช้จริง)
function setupText() {
  return `ตอนนี้${branding.SELF}ยังไม่รู้ว่าต้องทำหน้าที่อะไร เล่าให้ฟังได้เลยค่ะ พิมพ์แบบคุยกันธรรมดา ไม่ต้องครบทีเดียว เช่น
• ร้านขายเสื้อผ้าออนไลน์ เสื้อยืดตัวละ 290 ส่งไปรษณีย์ 50 บาท ช่วยตอบราคาและคิดยอดให้ลูกค้า
• ร้านกาแฟ เปิด 7 โมงถึง 5 โมงเย็น หยุดวันจันทร์ (แล้วส่งรูปเมนูตามมา)
• เป็นเลขาส่วนตัวให้ฉัน ช่วยจดงาน ถอดข้อความเสียง สรุปให้ตอนฉันถาม

${branding.SELF}จะร่างหน้าที่ให้ดูก่อน พิมพ์ ยืนยัน ถึงจะใช้จริง · ข้อมูลไหนยังไม่มี บอกเพิ่มทีหลังได้เรื่อยๆ
(พิมพ์ เมนู เพื่อดูคำสั่งทั้งหมด)`;
}

// ข้อความต้อนรับตอนพิมพ์รหัสเจ้าของ / กลับโหมดเจ้าของ — ยังไม่มีหน้าที่ = พาตั้งก่อน
async function welcomeText(db, first = true) {
  const hello = first ? `ยินดีต้อนรับค่ะ ${branding.SELF}จำได้แล้วว่าคุณเป็นเจ้าของ` : 'กลับมาโหมดเจ้าของแล้วค่ะ';
  const hasBrief = !!(await brief.current(db)).TEXT;
  return `${hello}\n\n${hasBrief ? menuText() : setupText()}`;
}

// ช่อง 〔...〕 ที่ยังเหลือ — บอกว่าใช้ไปก่อนได้ ลูกค้าถามเรื่องนั้นบอทจะไม่เดา
function missingNote(text) {
  const left = brief.placeholders(text);
  if (!left.length) return '';
  const shown = left.length > 8 ? `${left.slice(0, 8).join(' ')} และอีก ${left.length - 8} ช่อง` : left.join(' ');
  return `\n\n⚠️ ยังมีช่องที่ไม่ได้กรอก: ${shown}\nใช้ไปก่อนได้ ลูกค้าถามเรื่องนี้ บอทจะบอกว่าทางร้านจะแจ้ง · มีข้อมูลเมื่อไหร่พิมพ์บอกได้เลย`;
}

// คำสั่งตายตัวของเจ้าของ — คืนข้อความตอบ หรือ null = ไม่ใช่คำสั่ง (ส่งต่อให้ AI)
async function ownerCommand(userId, text, db) {
  const t = String(text || '').trim();

  if (['เมนู', 'เมนูเจ้าของ', 'ช่วย'].includes(t)) return menuText();

  if (t === 'ดูหน้าที่') {
    const cur = await brief.current(db);
    if (!cur.TEXT) {
      const draft = await db.getPendingBrief(userId);
      if (draft) return `ยังไม่ได้ใช้หน้าที่ไหนเลยค่ะ มีร่างรอยืนยันอยู่:\n\n${draft.text}\n\nพิมพ์ ยืนยัน เพื่อใช้ หรือพิมพ์บอกว่าอยากแก้ตรงไหน`;
      return `ยังไม่มีคำสั่งประจำตัวเลยค่ะ\n\n${setupText()}`;
    }
    const from = cur.SOURCE === 'chat' ? 'แก้ผ่านแชท' : 'จากไฟล์ brief.txt';
    return `คำสั่งประจำตัวที่ใช้อยู่ (${from} · ${cur.TEXT.length} ตัวอักษร):\n\n${cur.TEXT}`;
  }

  if (t === 'ยืนยัน') {
    const pending = await db.getPendingBrief(userId);
    if (!pending) return 'ตอนนี้ไม่มีอะไรรอยืนยันค่ะ (ร่างที่ค้างเกิน 24 ชม. จะหมดอายุเอง)';
    await db.addBriefVersion('chat', pending.text, userId);
    await db.clearPendingBrief(userId);
    const left = brief.placeholders(pending.text).length;
    const more = left ? `\nยังขาดข้อมูล ${left} ช่อง พิมพ์บอกเพิ่มได้เรื่อยๆ` : '';
    return `ใช้คำสั่งใหม่แล้วค่ะ ✅ ลูกค้าที่ทักมาหลังจากนี้จะได้คำตอบตามนี้ทันที${more}\nพิมพ์ ทดลองเป็นลูกค้า เพื่อลองคุยดูได้ · เปลี่ยนใจพิมพ์ ย้อนกลับ`;
  }

  if (t === 'ยกเลิก') {
    if (!(await db.getPendingBrief(userId))) return 'ไม่มีอะไรให้ยกเลิกค่ะ';
    await db.clearPendingBrief(userId);
    return 'ยกเลิกร่างแล้วค่ะ บอทยังใช้คำสั่งเดิม';
  }

  if (t === 'ย้อนกลับ') {
    const back = await db.popBriefVersion();
    if (!back) return 'ย้อนกลับไม่ได้ค่ะ มีคำสั่งประจำตัวฉบับเดียว';
    const preview = back.text.length > 300 ? `${back.text.slice(0, 300)}…` : back.text;
    return `ย้อนกลับไปใช้ฉบับก่อนหน้าแล้วค่ะ ↩️\n\n${preview}\n\nพิมพ์ ดูหน้าที่ เพื่อดูทั้งฉบับ`;
  }

  if (t === 'ทดลองเป็นลูกค้า') {
    await db.setOwnerMode(userId, 'customer');
    return `ตอนนี้คุยกับ${branding.BOT}แบบลูกค้าแล้วค่ะ ลองถามได้เลย (แชทช่วงนี้ไม่นับในรายงานลูกค้า)\nเสร็จแล้วพิมพ์ กลับโหมดเจ้าของ`;
  }

  if (t === 'เลิกเป็นเจ้าของ') {
    await db.removeOwner(userId);
    return 'ออกจากโหมดเจ้าของแล้วค่ะ จะกลับมาให้พิมพ์รหัสเจ้าของอีกครั้ง';
  }

  return null;
}

// AI ร่างคำสั่งใหม่มา → เก็บเป็นร่าง แล้วโชว์จุดที่เปลี่ยน (โค้ดคิด) ให้เจ้าของยืนยันเอง
async function proposeBrief(userId, reply, newBrief, db) {
  const cur = (await brief.current(db)).TEXT;
  const text = newBrief.trim();
  if (text.length > brief.MAX_CHARS) {
    return `${reply}\n\n⚠️ ร่างใหม่ยาว ${text.length} ตัวอักษร เกิน ${brief.MAX_CHARS} ที่ระบบรับได้ ยังไม่ได้เปลี่ยนอะไรนะคะ ลองสั่งให้ตัดส่วนที่ไม่จำเป็นออก`;
  }
  // ยังไม่มีฉบับไหนใช้อยู่ (เพิ่งติดตั้ง) → โชว์ร่างทั้งฉบับ ทุกบรรทัดใหม่หมด ดูแบบจุดเปลี่ยนจะโดนตัดเหลือ 20 บรรทัด
  if (!cur) {
    await db.setPendingBrief(userId, text);
    return `${reply}\n\nร่างหน้าที่${branding.BOT}:\n\n${text}${missingNote(text)}\n\nพิมพ์ ยืนยัน เพื่อใช้ทันที · อยากแก้ตรงไหนพิมพ์บอกได้เลย · ยกเลิก = ทิ้งร่าง`;
  }
  const diff = lineDiff(cur, text);
  if (!diff.length) return `${reply}\n\n(คำสั่งประจำตัวเหมือนเดิมทุกตัวอักษร ไม่มีอะไรต้องเปลี่ยน)`;
  await db.setPendingBrief(userId, text);
  return `${reply}\n\nจุดที่จะเปลี่ยน:\n${diff.join('\n')}${missingNote(text)}\n\nพิมพ์ ยืนยัน เพื่อใช้ทันที หรือ ยกเลิก`;
}

module.exports = { ownerCode, isOwnerCode, buildReport, lineDiff, menuText, setupText, welcomeText, ownerCommand, proposeBrief, MIN_CODE };
