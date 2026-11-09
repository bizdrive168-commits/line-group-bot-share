// ชุดทดสอบแบบ offline — ไม่ต้องมี LINE token หรือ OpenRouter key (รันใน CI ได้เลย)
// ครอบคลุม: ชื่อบอทจาก .env, คำสั่งประจำตัว (ไฟล์ / แก้ผ่านแชท / ย้อนกลับ), ฐานข้อมูล, prompt + ความจำ,
//          ตอบแชทลูกค้าครบทุกเส้นทาง, โหมดเจ้าของ (รหัส / รายงาน / แก้หน้าที่ / ยืนยัน / ทดลองเป็นลูกค้า)
const os = require('os');
const path = require('path');
const fs = require('fs');

// ใช้ DB ชั่วคราวแยกต่อการรัน 1 ครั้ง + ตั้งค่าเหมือนลูกค้าทำใน .env (ต้องตั้งก่อน require)
process.env.DB_PATH = path.join(os.tmpdir(), `chatbot-test-${process.pid}.db`);
process.env.BOT_NAME = 'น้องมะลิ';
process.env.LINE_CHANNEL_SECRET = 'test-secret'; // ให้ /webhook ตรวจลายเซ็นจริง (เทสยิง event ปลอมที่เซ็นเอง)
process.env.BOT_BRIEF = 'คุณคือแอดมินร้านขนมบ้านมะลิ\n- คุกกี้กล่องละ 120 บาท\n- ส่งฟรี 3 กล่อง';
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }

const dayjs = require('../src/time');
const db = require('../src/db');
const branding = require('../src/branding');
const brief = require('../src/brief');
const { buildMessages, systemPrompt, ownerPrompt, parseOwnerJSON, modelParams } = require('../src/ai');
const owner = require('../src/owner');
const { createBot, placeholder, dailyLimit, greeting, chunk } = require('../src/bot');

let pass = 0, fail = 0;
const q1 = async (sql, args = []) => (await db.run(sql, args)).rows[0];
function check(name, cond) {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}`);
}

const CODE = 'mali-owner-2026';
const ENV = { OWNER_CODE: CODE };

// ---------- LINE ปลอม — จดว่าบอทเรียกอะไรบ้าง ----------
function fakeClient({ replyFails = false } = {}) {
  const calls = { reply: [], push: [], leave: [], loading: [] };
  return {
    calls,
    last: () => calls.reply[calls.reply.length - 1]?.messages.map((m) => m.text).join('\n') || '',
    async replyMessage(req) { if (replyFails) throw new Error('Invalid reply token'); calls.reply.push(req); },
    async pushMessage(req) { calls.push.push(req); },
    async getProfile(id) { if (id === 'U-private') throw new Error('404'); return { displayName: id === 'U-owner' ? 'เอ' : 'พลอย' }; },
    async leaveGroup(id) { calls.leave.push(id); },
    async leaveRoom(id) { calls.leave.push(id); },
    async showLoadingAnimation(req) { calls.loading.push(req); },
  };
}
// AI ปลอม — คืนคำตอบตายตัว และจำว่าได้อะไรไป
function fakeAI(answer = 'คุกกี้กล่องละ 120 บาทค่ะ', { fails = false, ownerOut = { reply: 'วันนี้มีลูกค้า 1 คนค่ะ', newBrief: null } } = {}) {
  const seen = [], ownerSeen = [];
  return {
    seen, ownerSeen,
    ownerOut,
    async chatReply(rows, opts) { seen.push({ rows, opts }); if (fails) throw new Error('timeout'); return answer; },
    async ownerReply(rows, opts) { ownerSeen.push({ rows, opts }); if (fails) throw new Error('timeout'); return this.ownerOut; },
  };
}
const fakeMedia = { async readMedia(msg) { return msg.id === 'bad' ? null : '[รูป] สลิปโอน 240 บาท'; } };
const textEvent = (userId, text, id = `m-${Math.random()}`) => ({ type: 'message', replyToken: 'rt', source: { type: 'user', userId }, message: { type: 'text', id, text } });

async function main() {
  // ===== ชื่อบอท ตั้งเองจาก .env =====
  check('ชื่อบอทมาจาก BOT_NAME', branding.BOT === 'น้องมะลิ');
  check('เดาคำแทนตัวจากชื่อ: น้องมะลิ → น้อง', branding.SELF === 'น้อง');
  check('ไม่ตั้งอะไรเลย + อ่านชื่อ OA ไม่ได้ = แอดมิน', branding.resolve({}).BOT === 'แอดมิน');
  check('ตั้ง BOT_NAME ไว้ → ไม่เอาชื่อ OA มาทับ', branding.useLineName('ร้านบ้านมะลิ', { BOT_NAME: 'น้องมะลิ' }) === false && branding.BOT === 'น้องมะลิ');
  {
    const keep = { BOT: branding.BOT, SELF: branding.SELF };
    branding.useLineName('ร้านบ้านมะลิ', {});
    check('ไม่ตั้ง BOT_NAME → ใช้ชื่อ LINE OA + เรียกตัวเองว่าแอดมิน', branding.BOT === 'ร้านบ้านมะลิ' && branding.SELF === 'แอดมิน');
    check('ชื่อจาก LINE เข้า prompt + คำทักทายทันที (ไม่ต้องรีสตาร์ท)', systemPrompt({}).includes('"ร้านบ้านมะลิ"') && greeting({}).includes('ร้านบ้านมะลิ'));
    branding.useLineName('น้องใบเตย', {});
    check('ชื่อ OA ขึ้นต้นน้อง → เรียกตัวเองว่าน้อง', branding.SELF === 'น้อง');
    Object.assign(branding, keep);
  }
  check('ชื่อขึ้นต้น พี่ → เรียกตัวเองว่า พี่', branding.guessSelf('พี่หมี') === 'พี่');
  check('ชื่อฝรั่ง → เรียกชื่อตัวเองเต็ม', branding.guessSelf('MayBot') === 'MayBot');
  check('BOT_SELF สั่งทับได้', branding.resolve({ BOT_NAME: 'น้องมะลิ', BOT_SELF: 'มะลิ' }).SELF === 'มะลิ');
  check('BOT_EMOJI ตั้งเองได้', branding.resolve({ BOT_EMOJI: '🌼' }).EMOJI === '🌼');
  check('BOT_POLITE=ชาย → ลงท้ายครับ', branding.toMale('สวัสดีค่ะ ฝากตัวด้วยนะคะ') === 'สวัสดีครับ ฝากตัวด้วยนะครับ');
  check('BOT_POLITE=ชาย ไม่ทำคำว่าคะแนนพัง', branding.toMale('ได้ 5 คะแนนค่ะ') === 'ได้ 5 คะแนนครับ');
  check('ค่าเริ่มต้น (หญิง) ไม่แตะข้อความ', branding.resolve({}).say('สวัสดีค่ะ') === 'สวัสดีค่ะ');

  // ===== คำสั่งประจำตัว: อ่านจากไฟล์ / .env =====
  check('ไม่ตั้งอะไรเลย = ไม่มีคำสั่ง', brief.resolve({}, { readFile: () => '' }).SOURCE === 'none' && brief.block('') === '');
  check('อ่านจากไฟล์ได้ + ข้ามบรรทัด #', (() => { const b = brief.resolve({}, { readFile: () => '# หมายเหตุ\nเป็นเลขาส่วนตัว\n\n\n- เตือนนัด\n' }); return b.SOURCE === 'file' && b.TEXT === 'เป็นเลขาส่วนตัว\n\n- เตือนนัด'; })());
  check('.env ชนะไฟล์', brief.resolve({ BOT_BRIEF: 'จาก env' }, { readFile: () => 'จากไฟล์' }).TEXT === 'จาก env');
  check('BOT_BRIEF_FILE ชี้ไฟล์อื่นได้', (() => { let seen = null; brief.resolve({ BOT_BRIEF_FILE: './x.txt' }, { readFile: (f) => { seen = f; return 'ok'; } }); return seen === './x.txt'; })());
  check('ไม่ชี้ไฟล์ = อ่าน brief.txt ข้าง package.json', (() => { let seen = null; brief.resolve({}, { readFile: (f) => { seen = f; return ''; } }); return seen === brief.DEFAULT_FILE; })());
  check('คำสั่งยาวเกินถูกตัด', (() => { const b = brief.resolve({ BOT_BRIEF: 'ก'.repeat(brief.MAX_CHARS + 50) }); return b.TRUNCATED && b.TEXT.length === brief.MAX_CHARS; })());
  check('เจอช่องที่ยังไม่กรอก 〔...〕', JSON.stringify(brief.placeholders('ร้าน 〔ชื่อร้าน〕 เปิด 〔เวลา〕 〔ชื่อร้าน〕')) === JSON.stringify(['〔ชื่อร้าน〕', '〔เวลา〕']));

  check('ฝั่งลูกค้า: ช่อง 〔...〕 → (ยังไม่มีข้อมูล) ให้รู้ว่าไม่มีจริง', brief.forCustomers('- โอนเข้า 〔ธนาคาร〕 เลขที่ 〔เลขบัญชี〕') === '- โอนเข้า (ยังไม่มีข้อมูล) เลขที่ (ยังไม่มีข้อมูล)');
  check('ฝั่งลูกค้า: หลายบรรทัดก็แทนครบ', brief.forCustomers('〔ก〕\n〔ข〕\n〔ค〕') === '(ยังไม่มีข้อมูล)\n(ยังไม่มีข้อมูล)\n(ยังไม่มีข้อมูล)');
  check('prompt ลูกค้าไม่มีช่อง 〔...〕 หลุดไป', !systemPrompt({ briefText: 'ร้าน\nบัญชี 〔เลขบัญชี〕' }).includes('〔'));
  check('ด่านสุดท้าย: แทนช่องที่หลุดด้วยคำกลางๆ', brief.scrubPlaceholders('โอนเข้า 〔เลขบัญชี〕 ได้เลย') === 'โอนเข้า (ทางร้านจะแจ้งให้) ได้เลย');
  check('ด่านสุดท้าย: คำว่า (ยังไม่มีข้อมูล) ก็ไม่หลุด', brief.scrubPlaceholders('เลขที่ (ยังไม่มีข้อมูล)') === 'เลขที่ (ทางร้านจะแจ้งให้)');
  check('ด่านสุดท้าย: บรรทัดที่หลุดหลายจุด → ประโยคเดียวอ่านรู้เรื่อง', brief.scrubPlaceholders('รวม 390 บาท\nโอนเข้า (ยังไม่มีข้อมูล) เลขที่ (ยังไม่มีข้อมูล)') === 'รวม 390 บาท\nเรื่องนี้เดี๋ยวทางร้านแจ้งรายละเอียดให้นะคะ');

  // ===== ด่านกันตัวเลขแต่ง =====
  const { guardNumbers } = require('../src/guard');
  const srcs = ['โอนเข้า กสิกร 111-2-33333-4', 'ลูกค้า: โทร 081-234-5678'];
  check('เลขบัญชีที่ AI แต่ง → ตัดทิ้ง', guardNumbers('โอนเข้า 123-4-56789-0 นะคะ', srcs).text === 'โอนเข้า (ทางร้านจะแจ้งให้) นะคะ');
  check('เลขบัญชีที่มีในคำสั่ง → คงไว้ (เขียนต่างรูปแบบก็เจอ)', guardNumbers('บัญชี 1112333334', srcs).text === 'บัญชี 1112333334');
  check('เบอร์ที่ลูกค้าพิมพ์มาเอง → คงไว้', guardNumbers('เบอร์ 081 234 5678 ใช่ไหมคะ', srcs).text.includes('081 234 5678'));
  check('ราคา / รหัสไปรษณีย์ / เวลา ไม่โดน', guardNumbers('รวม 1,500 บาท ส่ง 10110 เวลา 14:00', srcs).text === 'รวม 1,500 บาท ส่ง 10110 เวลา 14:00');
  check('บอกว่าตัดอะไรไปบ้าง (ไว้ลง log)', guardNumbers('เบอร์ร้าน 02-999-8888', srcs).removed[0] === '02-999-8888');

  // ===== คลังหน้าที่สำเร็จรูป briefs/ =====
  const briefDir = path.join(__dirname, '..', 'briefs');
  const templates = fs.readdirSync(briefDir).filter((f) => f.endsWith('.txt'));
  check('คลังหน้าที่มีอย่างน้อย 6 แบบ', templates.length >= 6);
  for (const f of [...templates.map((t) => path.join(briefDir, t)), path.join(__dirname, '..', 'brief.example.txt')]) {
    const b = brief.resolve({ BOT_BRIEF_FILE: f });
    check(`แบบ ${path.basename(f)}: อ่านได้ ไม่เกินขนาด มีช่องให้กรอก`, b.SOURCE === 'file' && !b.TRUNCATED && brief.placeholders(b.TEXT).length > 0 && !b.TEXT.includes('cp briefs'));
  }

  // ===== คำสั่งประจำตัว: ฉบับล่าสุดชนะ =====
  check('ยังไม่บูต = ยังไม่มีฉบับไหน', (await brief.current(db)).SOURCE === 'none');

  // ===== ติดตั้งแบบไม่ต้องกรอกหน้าที่: เจ้าของเล่าให้บอทฟังผ่านแชททีหลัง =====
  {
    const client = fakeClient(), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: ENV });
    await bot.handleEvent(textEvent('U-new', 'มีเสื้อไหม'));
    check('ยังไม่มีหน้าที่ → ลูกค้าทักมายังตอบได้ (AI ได้คำสั่งว่าง)', ai.seen[0]?.opts.briefText === '');
    await bot.handleEvent(textEvent('U-setup', CODE));
    check('เจ้าของใหม่ + ยังไม่มีหน้าที่ → ชวนเล่าว่าอยากให้ทำอะไร', client.last().includes('ยังไม่รู้ว่าต้องทำหน้าที่อะไร') && client.last().includes('ยืนยัน'));
    ai.ownerOut = { reply: 'ร่างเป็นแอดมินร้านเสื้อให้แล้วค่ะ', newBrief: 'คุณคือแอดมินร้านเสื้อ\n- เสื้อยืด 290 บาท\n- โอนเข้า 〔เลขบัญชี〕' };
    await bot.handleEvent(textEvent('U-setup', 'ขายเสื้อยืด ตัวละ 290'));
    const first = client.last();
    check('ร่างแรก → โชว์ทั้งฉบับ (ไม่ใช่จุดเปลี่ยน) + บอกช่องที่ขาด', first.includes('ร่างหน้าที่') && first.includes('คุณคือแอดมินร้านเสื้อ') && !first.includes('+ ') && first.includes('〔เลขบัญชี〕') && first.includes('ใช้ไปก่อนได้'));
    check('ร่างแรกยังไม่ใช้จนกว่าจะยืนยัน', (await brief.current(db)).SOURCE === 'none');
    ai.ownerOut = { reply: 'เพิ่มค่าส่งแล้วค่ะ', newBrief: 'คุณคือแอดมินร้านเสื้อ\n- เสื้อยืด 290 บาท\n- ค่าส่ง 50 บาท\n- โอนเข้า 〔เลขบัญชี〕' };
    await bot.handleEvent(textEvent('U-setup', 'ค่าส่ง 50'));
    check('บอกเพิ่มต่อ → AI ได้ร่างเดิมไปแก้ต่อ (ของที่เพิ่งบอกไม่หาย)', ai.ownerSeen[1]?.opts.draftText.includes('เสื้อยืด 290') && ai.ownerSeen[1].opts.briefText === '');
    await bot.handleEvent(textEvent('U-setup', 'ดูหน้าที่'));
    check('ดูหน้าที่ตอนยังไม่ยืนยัน → เห็นร่างที่รอ', client.last().includes('ร่างรอยืนยัน') && client.last().includes('ค่าส่ง 50'));
    await bot.handleEvent(textEvent('U-setup', 'ยืนยัน'));
    check('ยืนยันร่างแรก → ใช้ทันที + บอกว่ายังขาดกี่ช่อง', (await brief.current(db)).TEXT.includes('ค่าส่ง 50') && client.last().includes('ขาดข้อมูล 1 ช่อง'));
    await bot.handleEvent(textEvent('U-setup', 'ทดลองเป็นลูกค้า'));
    await bot.handleEvent(textEvent('U-setup', 'กลับโหมดเจ้าของ'));
    check('มีหน้าที่แล้ว กลับโหมดเจ้าของ → ได้เมนูปกติ', client.last().includes('ถามเรื่องลูกค้าได้เลย'));
    // ล้างกลับ ให้เทสส่วนถัดไปเริ่มจาก "ยังไม่มีฉบับไหน" เหมือนเดิม
    await db.run('DELETE FROM brief_versions');
    await db.run("DELETE FROM messages WHERE user_id IN ('U-new', 'U-setup')");
    await db.removeOwner('U-setup');
  }
  (await brief.syncBoot(db));
  check('บูตครั้งแรก → บันทึกฉบับจากไฟล์', (await brief.current(db)).SOURCE === 'file' && (await brief.current(db)).TEXT.includes('บ้านมะลิ'));
  (await brief.syncBoot(db));
  check('บูตซ้ำ ไฟล์ไม่เปลี่ยน = ไม่เพิ่มฉบับ', (await db.countBriefVersions()) === 1);
  (await db.addBriefVersion('chat', 'ฉบับที่เจ้าของแก้ในแชท', 'U-owner'));
  (await brief.syncBoot(db));
  check('แก้ในแชทแล้วรีสตาร์ท (ไฟล์เดิม) → ยังใช้ฉบับแชท', (await brief.current(db)).SOURCE === 'chat');
  (await brief.syncBoot(db, { BOT_BRIEF: 'ไฟล์ฉบับใหม่' }));
  check('แก้ไฟล์ทีหลัง → ฉบับไฟล์ชนะ', (await brief.current(db)).TEXT === 'ไฟล์ฉบับใหม่');
  check('ย้อนกลับ → กลับไปฉบับแชท', (await db.popBriefVersion()).text === 'ฉบับที่เจ้าของแก้ในแชท');
  (await db.popBriefVersion());
  check('ย้อนกลับจนเหลือฉบับเดียว = ย้อนต่อไม่ได้', (await db.popBriefVersion()) === null && (await brief.current(db)).TEXT.includes('บ้านมะลิ'));

  // ===== prompt =====
  const sys = systemPrompt({ name: 'พลอย', briefText: (await brief.current(db)).TEXT });
  check('prompt ใช้ชื่อบอทที่ตั้ง', sys.includes('"น้องมะลิ"') && sys.includes('"น้อง"'));
  check('prompt รู้ว่ากำลังคุยกับใคร', sys.includes('คุณพลอย'));
  check('prompt ใช้คำสั่งฉบับที่ส่งให้', sys.includes('ร้านขนมบ้านมะลิ') && sys.includes('ยึดตามนี้เสมอ'));
  check('prompt ส่งคำสั่งเองได้ (ใช้ตอนลองในเครื่อง)', systemPrompt({ briefText: 'ร้านทดสอบ' }).includes('ร้านทดสอบ'));
  check('prompt บอกวันที่ปัจจุบันเป็น พ.ศ.', sys.includes(String(dayjs().tz().year() + 543)));
  check('prompt สั่งห้ามเดาข้อมูล', sys.includes('ห้ามเดา'));
  check('ไม่มีคำสั่ง = ไม่มีก้อนคำสั่งจากเจ้าของ', !systemPrompt({ briefText: '' }).includes('ยึดตามนี้เสมอ'));
  const op = ownerPrompt({ name: 'เอ', briefText: 'คำสั่งเดิม', report: 'สถิติ: x' });
  check('prompt เจ้าของมีคำสั่งเดิม + รายงาน + สั่งตอบ JSON', op.includes('คำสั่งเดิม') && op.includes('สถิติ: x') && op.includes('"new_brief"'));
  check('ยังไม่มีหน้าที่ → AI ลูกค้าถูกสั่งไม่ให้ตอบเรื่องร้านเอง', systemPrompt({ briefText: '' }).includes('ยังไม่ได้บอกหน้าที่') && !sys.includes('ยังไม่ได้บอกหน้าที่'));
  const setupP = ownerPrompt({ briefText: '' });
  check('ยังไม่มีหน้าที่ → prompt เจ้าของพาตั้งหน้าที่ + มีแบบสำเร็จรูปเป็นโครง', setupP.includes('เพิ่งติดตั้ง') && setupP.includes('== ร้านขายของออนไลน์ ==') && !op.includes('เพิ่งติดตั้ง'));
  check('มีร่างค้าง → prompt เจ้าของได้ร่างไปแก้ต่อ', ownerPrompt({ briefText: 'เดิม', draftText: 'ร่างใหม่ล่าสุด' }).includes('ร่างใหม่ล่าสุด'));
  check('อ่านแบบสำเร็จรูปได้ครบ + ชื่อแบบจากบรรทัดแรก', brief.templates().length === templates.length && brief.templates().some((t) => t.label === 'ร้านขายของออนไลน์'));
  check('โฟลเดอร์แบบหาย → ไม่ล้ม (ใช้โครง 4 หัวข้อแทน)', brief.templates('/no-such-dir').length === 0 && ownerPrompt({ briefText: '', templates: [] }).includes('4 หัวข้อ'));

  // ===== อ่านคำตอบ JSON ของโหมดเจ้าของ =====
  check('JSON ปกติ', (() => { const p = parseOwnerJSON('{"reply":"ได้ค่ะ","new_brief":null}'); return p.ok && p.reply === 'ได้ค่ะ' && p.newBrief === null; })());
  check('JSON ขาดกลางทาง → ไม่เอาเศษ JSON ไปตอบเจ้าของ (ให้ลองโมเดลถัดไป)', (() => { const p = parseOwnerJSON('{"reply":"ร่างให้แล้ว","new_brief":"คุณคือแอด'); return !p.ok && !p.reply; })());
  check('ร่างที่ก๊อปหัว "== ชื่อแบบ ==" ติดมา → ตัดทิ้ง', parseOwnerJSON('{"reply":"x","new_brief":"== ร้านขายของออนไลน์ ==\\nคุณคือแอดมิน"}').newBrief === 'คุณคือแอดมิน');
  check('โหมดเจ้าของ: gemini ก่อน (ตอบ JSON ครบ ไว) แล้ว deepseek สำรอง', JSON.stringify(require('../src/ai').ownerModels()) === JSON.stringify(['google/gemini-3.1-flash-lite', 'deepseek/deepseek-v4.1-flash']));
  check('JSON ห่อ ```json มา', parseOwnerJSON('```json\n{"reply":"แก้แล้ว","new_brief":"ใหม่"}\n```').newBrief === 'ใหม่');
  check('ไม่ใช่ JSON = ถือเป็นคำตอบ ไม่แตะคำสั่ง', (() => { const p = parseOwnerJSON('สวัสดีค่ะ'); return p.reply === 'สวัสดีค่ะ' && p.newBrief === null; })());
  check('new_brief ว่าง = ไม่แก้', parseOwnerJSON('{"reply":"x","new_brief":"  "}').newBrief === null);
  check('ร่างที่ก๊อป <<< >>> ติดมา → ตัดทิ้ง', parseOwnerJSON('{"reply":"x","new_brief":"<<<\\nร้านมะลิ\\n- ราคา 130\\n>>>"}').newBrief === 'ร้านมะลิ\n- ราคา 130');

  // ===== โมเดลค่าเริ่มต้น + ตัวสำรอง =====
  const withEnv = (env, fn) => { const keep = {}; for (const k of Object.keys(env)) { keep[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } try { return fn(); } finally { for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } } };
  check('ค่าเริ่มต้น = deepseek + สำรอง gemini-3.1-flash-lite', withEnv({ AI_MODEL: undefined, AI_FALLBACK_MODEL: undefined }, () => JSON.stringify(modelParams())) === JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', models: ['deepseek/deepseek-v4.1-flash', 'google/gemini-3.1-flash-lite'] }));
  check('AI_MODEL เปลี่ยนตัวหลักได้', withEnv({ AI_MODEL: 'anthropic/claude-haiku-5.5', AI_FALLBACK_MODEL: undefined }, () => modelParams().models[0]) === 'anthropic/claude-haiku-5.5');
  check('AI_FALLBACK_MODEL=none → ไม่มีตัวสำรอง', withEnv({ AI_MODEL: undefined, AI_FALLBACK_MODEL: 'none' }, () => modelParams().models) === undefined);
  check('ตัวหลักกับตัวสำรองเป็นตัวเดียวกัน → ไม่ใส่ซ้ำ', withEnv({ AI_MODEL: 'google/gemini-3.1-flash-lite', AI_FALLBACK_MODEL: undefined }, () => modelParams().models) === undefined);

  // ===== ความจำบทสนทนา → messages ของ AI =====
  const ts = '2026-11-09 03:00:00'; // = 10:00 เวลาไทย
  const msgs = buildMessages([
    { role: 'bot', type: 'text', text: 'สวัสดีค่ะ', ts },
    { role: 'user', type: 'text', text: 'คุกกี้ราคาเท่าไหร่', ts },
    { role: 'bot', type: 'text', text: '120 บาทค่ะ', ts },
    { role: 'user', type: 'image', text: null, ts },
  ], { name: 'พลอย' });
  check('ข้อความแรกเป็น system', msgs[0].role === 'system');
  check('ตัดข้อความบอทที่ขึ้นก่อนผู้ใช้ทิ้ง (เริ่มด้วย user)', msgs[1].role === 'user');
  check('บอท = assistant · คน = user', msgs.map((m) => m.role).join(',') === 'system,user,assistant,user');
  check('ข้อความคนมีเวลาไทยกำกับ', msgs[1].content === '[9/11 10:00] คุกกี้ราคาเท่าไหร่');
  check('ข้อความบอทไม่มีเวลากำกับ', msgs[2].content === '120 บาทค่ะ');
  check('สื่อที่ยังไม่มีข้อความ → [ชนิด]', msgs[3].content.endsWith('[image]'));
  const long = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'bot' : 'user', type: 'text', text: `ข้อความที่ ${i} ` + 'ก'.repeat(200), ts }));
  const trimmed = buildMessages(long, { maxChars: 2000 });
  check('ประวัติยาวเกิน → ตัดของเก่าทิ้ง เก็บของใหม่', trimmed.length < 15 && trimmed[trimmed.length - 1].content.includes('ข้อความที่ 49'));
  check('ข้อความล่าสุดยาวเกินงบก็ยังส่งไป', buildMessages([{ role: 'user', type: 'text', text: 'ก'.repeat(9000), ts }], { maxChars: 100 }).length === 2);

  // ===== ฐานข้อมูล =====
  (await db.upsertUser('U1', 'พลอย'));
  (await db.upsertUser('U1', null));
  check('จำชื่อคนคุย และไม่ถูกลบด้วยค่าว่าง', (await db.userName('U1')) === 'พลอย');
  check('คนไม่รู้จัก = ชื่อว่าง', (await db.userName('Ux')) === '');
  const r1 = (await db.logMessage('U1', 'user', 'lm1', 'text', 'สวัสดี'));
  (await db.logMessage('U1', 'bot', null, 'text', 'สวัสดีค่ะ'));
  (await db.logMessage('U2', 'user', 'lm2', 'text', 'ของคนอื่น'));
  (await db.logMessage('U1', 'user', null, 'text', 'คุยโหมดเจ้าของ', 'owner'));
  check('บทสนทนาแยกรายคน', (await db.recentMessages('U1')).length === 2 && (await db.recentMessages('U2')).length === 1);
  check('ความจำโหมดเจ้าของแยกจากแชทปกติ', (await db.recentMessages('U1', 60, 'owner')).length === 1);
  check('เรียงเก่า → ใหม่', (await db.recentMessages('U1'))[0].id === r1);
  check('นับข้อความวันนี้เฉพาะฝั่งคน (ไม่นับโหมดเจ้าของ)', (await db.userMessagesToday('U1')) === 1);
  check('อัพเดตข้อความ (สื่อ)', ((await db.updateMessageText(r1, 'แก้แล้ว')), (await db.recentMessages('U1'))[0].text === 'แก้แล้ว'));
  check('unsend ลบตาม', (await db.deleteByLineMsgId('lm1')) === true && (await db.recentMessages('U1')).length === 1);
  check('unsend id มั่ว = false', (await db.deleteByLineMsgId('nope')) === false);

  // ===== ตัวช่วยเล็กๆ =====
  check('placeholder สติกเกอร์มีอารมณ์', placeholder({ type: 'sticker', keywords: ['happy', 'love'] }) === '[สติกเกอร์: happy love]');
  check('placeholder ตำแหน่ง', placeholder({ type: 'location', title: 'ร้าน', address: 'ถนนสุขุมวิท' }) === '[ตำแหน่ง] ร้าน ถนนสุขุมวิท');
  check('เพดานต่อวัน ค่าเริ่มต้น 100', dailyLimit({}) === 100);
  check('DAILY_LIMIT=0 = ไม่จำกัด', dailyLimit({ DAILY_LIMIT: '0' }) === 0);
  check('DAILY_LIMIT มั่ว → 100', dailyLimit({ DAILY_LIMIT: 'abc' }) === 100);
  check('คำทักทายใช้ชื่อบอท', greeting({}).includes('น้องมะลิ'));
  check('BOT_GREETING ตั้งเองได้', greeting({ BOT_GREETING: 'ยินดีต้อนรับสู่ร้านมะลิ' }) === 'ยินดีต้อนรับสู่ร้านมะลิ');
  const parts = chunk(('บรรทัดยาว '.repeat(50) + '\n').repeat(40));
  check('ข้อความยาวตัดเป็นหลายกล่อง กล่องละไม่เกิน 4,900', parts.length > 1 && parts.every((p) => p.length <= 4900));
  check('ข้อความสั้นได้กล่องเดียว', chunk('สั้นๆ').length === 1);
  check('ตัดไม่เกิน 5 กล่อง (เพดาน LINE)', chunk('ก'.repeat(40000)).length === 5);

  // ===== รหัสเจ้าของ =====
  check('ไม่ตั้ง OWNER_CODE = ปิดโหมดเจ้าของ', owner.isOwnerCode('อะไรก็ได้', {}) === false);
  check('รหัสสั้นกว่า 8 ตัว = ปิด', owner.isOwnerCode('1234', { OWNER_CODE: '1234' }) === false);
  check('พิมพ์รหัสตรง = ใช่', owner.isOwnerCode(CODE, ENV) === true);
  check('มีเว้นวรรคหน้าหลังก็ยังใช่', owner.isOwnerCode(`  ${CODE} `, ENV) === true);
  check('รหัสผิด = ไม่ใช่', owner.isOwnerCode('mali-owner-2025', ENV) === false);
  check('ข้อความไทยยาวเท่ารหัส → ไม่ล่ม และไม่ใช่', owner.isOwnerCode('ก'.repeat(CODE.length), ENV) === false);

  // ===== จุดที่เปลี่ยนในคำสั่ง (โค้ดคิด) =====
  check('แก้บรรทัดเดียว → − เก่า แล้ว + ใหม่', JSON.stringify(owner.lineDiff('ก\nราคา 120\nค', 'ก\nราคา 130\nค')) === JSON.stringify(['− ราคา 120', '+ ราคา 130']));
  check('เพิ่มบรรทัด → + อย่างเดียว', JSON.stringify(owner.lineDiff('ก', 'ก\nข')) === JSON.stringify(['+ ข']));
  check('เหมือนเดิม = ไม่มีจุดเปลี่ยน', owner.lineDiff('ก\nข', 'ก\nข').length === 0);
  check('เปลี่ยนเยอะ → โชว์ 20 บรรทัด + บอกจำนวนที่เหลือ', (() => { const d = owner.lineDiff('', Array.from({ length: 30 }, (_, i) => `บรรทัด ${i}`).join('\n')); return d.length === 21 && d[20].includes('อีก 10'); })());

  // ===== ตอบแชทลูกค้า (LINE + AI ปลอม) =====
  {
    const client = fakeClient(), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: ENV });
    check('แอดเพื่อน → ทักทาย', (await bot.handleEvent({ type: 'follow', replyToken: 'rt', source: { type: 'user', userId: 'U3' } })) === 'greeted');
    check('ทักทายด้วยคำทักทายของบอท', client.last().includes('น้องมะลิ'));
    check('แอดเพื่อน → จำชื่อจากโปรไฟล์', (await db.userName('U3')) === 'พลอย');

    check('ข้อความ → AI ตอบ', (await bot.handleEvent(textEvent('U3', 'คุกกี้ราคาเท่าไหร่', 'm1'))) === 'answered');
    check('ตอบกลับด้วยคำตอบของ AI', client.last() === 'คุกกี้กล่องละ 120 บาทค่ะ');
    check('ขึ้นจุดกำลังพิมพ์ก่อนตอบ', client.calls.loading[0]?.chatId === 'U3');
    check('AI เห็นบทสนทนาก่อนหน้า (คำทักทาย + คำถาม)', ai.seen[0].rows.length === 2 && ai.seen[0].rows[1].text === 'คุกกี้ราคาเท่าไหร่');
    check('AI รู้ชื่อคนคุย + ได้คำสั่งฉบับล่าสุด', ai.seen[0].opts.name === 'พลอย' && ai.seen[0].opts.briefText.includes('บ้านมะลิ'));
    check('เก็บคำตอบบอทไว้ในความจำ', (await db.recentMessages('U3')).slice(-1)[0].role === 'bot');

    const img = { type: 'message', replyToken: 'rt', source: { type: 'user', userId: 'U3' }, message: { type: 'image', id: 'img1' } };
    await bot.handleEvent(img);
    check('ส่งรูป → อ่านรูปก่อนแล้ว AI ตอบต่อจากที่อ่าน', ai.seen[1].rows.slice(-1)[0].text === '[รูป] สลิปโอน 240 บาท');
    check('สื่อขึ้นจุดกำลังพิมพ์นานขึ้น', client.calls.loading[1]?.loadingSeconds === 60);
    await bot.handleEvent({ ...img, message: { type: 'image', id: 'bad' } });
    check('อ่านรูปไม่ออก → AI เห็นแค่ [รูป]', ai.seen[2].rows.slice(-1)[0].text === '[รูป]');

    check('unsend → ลบจากความจำ', (await bot.handleEvent({ type: 'unsend', source: { type: 'user', userId: 'U3' }, unsend: { messageId: 'm1' } })) === 'unsent' && !(await db.recentMessages('U3')).some((m) => m.line_msg_id === 'm1'));
  }
  {
    const client = fakeClient(), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: ENV });
    const join = { type: 'join', replyToken: 'rt', source: { type: 'group', groupId: 'G1' } };
    check('ถูกเชิญเข้ากลุ่ม → ออกเอง', (await bot.handleEvent(join)) === 'left' && client.calls.leave[0] === 'G1');
    check('บอกในกลุ่มก่อนออกว่าคุยได้เฉพาะแชทส่วนตัว', client.last().includes('แชทส่วนตัว'));
    await bot.handleEvent({ type: 'message', replyToken: 'rt', source: { type: 'room', roomId: 'R1', userId: 'U9' }, message: { type: 'text', id: 'x', text: 'สวัสดี' } });
    check('ข้อความในห้องรวม → ออก ไม่เรียก AI', client.calls.leave[1] === 'R1' && ai.seen.length === 0);
  }
  {
    const client = fakeClient(), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: { DAILY_LIMIT: '1' } });
    await bot.handleEvent(textEvent('U4', 'ข้อแรก'));
    check('ครบเพดานต่อวัน → ตอบสั้น ไม่เรียก AI', (await bot.handleEvent(textEvent('U4', 'ข้อสอง'))) === 'limit' && ai.seen.length === 1);
    check('ข้อความที่เกินเพดานไม่ถูกเก็บ', (await db.recentMessages('U4')).filter((m) => m.role === 'user').length === 1);
  }
  {
    const client = fakeClient(), ai = fakeAI('', { fails: true });
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    check('AI ล่ม → ขอโทษ ไม่เงียบ', (await bot.handleEvent(textEvent('U5', 'สวัสดี'))) === 'error' && client.last().includes('ขอโทษ'));
  }
  {
    const client = fakeClient(), ai = fakeAI('โอนเข้า 〔เลขบัญชี〕 ได้เลยค่ะ');
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    await bot.handleEvent(textEvent('U8', 'โอนที่ไหน'));
    check('AI หลุดช่อง 〔...〕 → ลูกค้าไม่เห็น', !client.last().includes('〔') && client.last().includes('ทางร้านจะแจ้งให้'));
  }
  {
    const client = fakeClient(), ai = fakeAI('โอนเข้ากสิกร 123-4-56789-0 ได้เลยค่ะ');
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    await bot.handleEvent(textEvent('U8', 'เลขบัญชีอะไร'));
    check('AI แต่งเลขบัญชี → ลูกค้าไม่ได้เลขปลอม', !client.last().includes('56789') && client.last().includes('ทางร้านจะแจ้งให้'));
  }
  {
    const client = fakeClient({ replyFails: true }), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    await bot.handleEvent(textEvent('U6', 'สวัสดี'));
    check('replyToken หมดอายุ → ส่งแบบ push แทน', client.calls.push[0]?.to === 'U6');
  }
  {
    const client = fakeClient(), ai = fakeAI('');
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    await bot.handleEvent(textEvent('U-private', 'สวัสดี'));
    check('AI คืนคำตอบว่าง → มีข้อความสำรอง', client.last().includes('ขอโทษ'));
    check('โปรไฟล์ไม่เปิด → ยังคุยได้ ชื่อว่าง', (await db.userName('U-private')) === '' && ai.seen[0].opts.name === '');
  }

  // ===== โหมดเจ้าของ =====
  {
    const client = fakeClient(), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: ENV });
    const before = (await q1('SELECT count(*) c FROM messages')).c;
    check('พิมพ์รหัสเจ้าของ → เป็นเจ้าของ', (await bot.handleEvent(textEvent('U-owner', CODE))) === 'owner-added' && (await db.ownerMode('U-owner')) === 'owner');
    check('ได้เมนูเจ้าของทันที', client.last().includes('โหมดเจ้าของ'));
    check('รหัสไม่ถูกเก็บลงฐานข้อมูล', (await q1('SELECT count(*) c FROM messages')).c === before && !(await q1('SELECT 1 FROM messages WHERE text LIKE ?', [`%${CODE}%`])));
    check('ไม่ได้ตั้ง OWNER_CODE → รหัสเป็นแค่ข้อความธรรมดา', (await createBot({ client: fakeClient(), ai: fakeAI(), media: fakeMedia, env: {} }).handleEvent(textEvent('U7', CODE))) === 'answered');

    // ถามเรื่องลูกค้า
    check('เจ้าของถาม → ใช้ AI โหมดเจ้าของ', (await bot.handleEvent(textEvent('U-owner', 'วันนี้มีใครทักบ้าง'))) === 'owner-answered' && ai.ownerSeen.length === 1 && ai.seen.length === 0);
    const report = ai.ownerSeen[0].opts.report;
    check('รายงานมีลูกค้าที่ทักวันนี้ + ตัวเลขจาก SQL', report.includes('คุณพลอย') && /วันนี้มีลูกค้าทัก \d+ คน/.test(report));
    check('รายงานไม่นับเจ้าของเป็นลูกค้า', !report.includes('คุณเอ'));
    check('ลูกค้าไม่รู้ชื่อ → ป้าย #เลขท้าย', report.includes('ลูกค้าไม่ทราบชื่อ #vate'));
    check('รายงานมีบทสนทนาลูกค้า (รวมสลิปที่อ่านได้)', report.includes('สลิปโอน 240 บาท'));
    check('AI เจ้าของได้คำสั่งที่ใช้อยู่', ai.ownerSeen[0].opts.briefText.includes('บ้านมะลิ'));
    check('ตอบเจ้าของด้วยคำตอบของ AI', client.last() === 'วันนี้มีลูกค้า 1 คนค่ะ');
    check('บทสนทนาเจ้าของอยู่เลน owner ไม่ปนแชทลูกค้า', (await db.recentMessages('U-owner', 60, 'owner')).length === 2 && (await db.recentMessages('U-owner')).length === 0);

    // คำสั่งตายตัว
    await bot.handleEvent(textEvent('U-owner', 'ดูหน้าที่'));
    check('ดูหน้าที่ → โชว์คำสั่งเต็มฉบับ', client.last().includes('คุกกี้กล่องละ 120 บาท') && client.last().includes('จากไฟล์'));
    await bot.handleEvent(textEvent('U-owner', 'ยืนยัน'));
    check('ยืนยันตอนไม่มีร่าง → บอกว่าไม่มี', client.last().includes('ไม่มีอะไรรอยืนยัน'));
    check('คำสั่งตายตัวไม่เรียก AI', ai.ownerSeen.length === 1);

    // แก้หน้าที่ผ่านแชท
    const oldText = (await brief.current(db)).TEXT;
    ai.ownerOut = { reply: 'แก้ราคาคุกกี้เป็น 130 บาทแล้วค่ะ', newBrief: oldText.replace('120', '130') };
    await bot.handleEvent(textEvent('U-owner', 'แก้ราคาคุกกี้เป็น 130'));
    check('สั่งแก้ → โชว์จุดเปลี่ยนที่โค้ดคิด + ขอยืนยัน', client.last().includes('− คุกกี้กล่องละ 120 บาท') && client.last().includes('+ คุกกี้กล่องละ 130 บาท') && client.last().includes('พิมพ์ ยืนยัน'));
    check('ยังไม่ยืนยัน = บอทยังใช้ฉบับเดิม', (await brief.current(db)).TEXT === oldText);
    await bot.handleEvent(textEvent('U-owner', 'ยืนยัน'));
    check('ยืนยัน → ใช้ฉบับใหม่ทันที (มาจากแชท)', (await brief.current(db)).TEXT.includes('130 บาท') && (await brief.current(db)).SOURCE === 'chat');
    await bot.handleEvent(textEvent('U3', 'ราคาเท่าไหร่'));
    check('ลูกค้าคนถัดไปได้คำสั่งฉบับใหม่', ai.seen.slice(-1)[0].opts.briefText.includes('130 บาท'));

    ai.ownerOut = { reply: 'ไม่มีอะไรต้องแก้ค่ะ', newBrief: (await brief.current(db)).TEXT };
    await bot.handleEvent(textEvent('U-owner', 'เช็คหน่อย'));
    check('ร่างเหมือนเดิมทุกตัว → ไม่สร้างร่าง', client.last().includes('ไม่มีอะไรต้องเปลี่ยน') && !(await db.getPendingBrief('U-owner')));
    ai.ownerOut = { reply: 'เพิ่มแล้วค่ะ', newBrief: 'ก'.repeat(brief.MAX_CHARS + 1) };
    await bot.handleEvent(textEvent('U-owner', 'ใส่เมนูทั้งหมด'));
    check('ร่างยาวเกิน → เตือน ไม่สร้างร่าง', client.last().includes('เกิน') && !(await db.getPendingBrief('U-owner')));
    ai.ownerOut = { reply: 'ร่างให้แล้วค่ะ', newBrief: `${(await brief.current(db)).TEXT}\n- เปิด 〔เวลาเปิด〕` };
    await bot.handleEvent(textEvent('U-owner', 'เพิ่มเวลาเปิด'));
    check('ร่างมีช่องยังไม่กรอก → เตือน', client.last().includes('〔เวลาเปิด〕') && client.last().includes('ไม่ได้กรอก'));
    await bot.handleEvent(textEvent('U-owner', 'ยกเลิก'));
    check('ยกเลิก → ทิ้งร่าง ใช้ฉบับเดิม', !(await db.getPendingBrief('U-owner')) && !(await brief.current(db)).TEXT.includes('เวลาเปิด'));

    await bot.handleEvent(textEvent('U-owner', 'ย้อนกลับ'));
    check('ย้อนกลับ → กลับไปราคา 120', (await brief.current(db)).TEXT.includes('120 บาท') && client.last().includes('ย้อนกลับ'));

    // ทดลองเป็นลูกค้า
    await bot.handleEvent(textEvent('U-owner', 'ทดลองเป็นลูกค้า'));
    check('ทดลองเป็นลูกค้า → เปลี่ยนโหมด', (await db.ownerMode('U-owner')) === 'customer');
    const seenBefore = ai.seen.length;
    check('โหมดลูกค้า → คุยกับ AI ลูกค้า', (await bot.handleEvent(textEvent('U-owner', 'คุกกี้มีกี่แบบ'))) === 'answered' && ai.seen.length === seenBefore + 1);
    check('แชทตอนทดลองไม่โผล่ในรายงานลูกค้า', !(await owner.buildReport(db)).includes('คุกกี้มีกี่แบบ'));
    const limited = createBot({ client: fakeClient(), ai: fakeAI(), media: fakeMedia, env: { ...ENV, DAILY_LIMIT: '1' } });
    check('เจ้าของไม่โดนเพดานต่อวัน', (await limited.handleEvent(textEvent('U-owner', 'อีกข้อ'))) === 'answered');
    await bot.handleEvent(textEvent('U-owner', 'กลับโหมดเจ้าของ'));
    check('กลับโหมดเจ้าของ', (await db.ownerMode('U-owner')) === 'owner' && client.last().includes('โหมดเจ้าของ'));

    check('ลูกค้าพิมพ์ "ดูหน้าที่" → เป็นแค่คำถามธรรมดา ไม่เห็นคำสั่ง', (await bot.handleEvent(textEvent('U3', 'ดูหน้าที่'))) === 'answered');
    await bot.handleEvent(textEvent('U-owner', 'เลิกเป็นเจ้าของ'));
    check('เลิกเป็นเจ้าของ → กลับเป็นคนทั่วไป', (await db.ownerMode('U-owner')) === null);
  }
  {
    const client = fakeClient(), ai = fakeAI('', { fails: true });
    const bot = createBot({ client, ai, media: fakeMedia, env: ENV });
    await bot.handleEvent(textEvent('U-owner2', CODE));
    check('AI ล่มในโหมดเจ้าของ → ขอโทษ ไม่เงียบ', (await bot.handleEvent(textEvent('U-owner2', 'สรุปวันนี้'))) === 'error' && client.last().includes('ขอโทษ'));
  }

  // ===== AI ค้าง / ตอบขาดกลางทาง → ลองตัวถัดไป (client ปลอม ไม่ต่อเน็ต) =====
  {
    const aiMod = require('../src/ai');
    const fakeOpenAI = (answers) => {
      const asked = [];
      return { asked, chat: { completions: { async create(body) { asked.push(body.model); const a = answers.shift(); if (a instanceof Error) throw a; return { choices: [{ finish_reason: a.finish || 'stop', message: { content: a.content } }] }; } } } };
    };
    let f = fakeOpenAI([{ content: '{"reply":"ร่างให้แล้ว","new_brief":"คุณคือแอด', finish: 'error' }, { content: '{"reply":"ร่างให้แล้วค่ะ","new_brief":"คุณคือแอดมิน"}' }]);
    aiMod.setClient(f);
    const r = await aiMod.ownerReply([{ role: 'user', type: 'text', text: 'ขายเสื้อ', ts: new Date().toISOString() }], {});
    check('โหมดเจ้าของ: ตัวแรกขาดกลางทาง → ได้คำตอบครบจากตัวที่สอง', r.newBrief === 'คุณคือแอดมิน' && f.asked.length === 2 && f.asked[0] !== f.asked[1]);
    f = fakeOpenAI([new Error('timeout'), new Error('terminated')]);
    aiMod.setClient(f);
    check('โหมดเจ้าของ: ล่มทั้งสองตัว → โยน error (บอทตอบ "ระบบสะดุด" ไม่ส่งเศษ)', await aiMod.ownerReply([{ role: 'user', type: 'text', text: 'x', ts: new Date().toISOString() }], {}).then(() => false, () => true));
    f = fakeOpenAI([{ content: 'เสื้อยืดตัวละ 29', finish: 'error' }, { content: 'เสื้อยืดตัวละ 290 บาทค่ะ' }]);
    aiMod.setClient(f);
    check('ตอบลูกค้า: ตัวหลักขาดกลางทาง → ใช้คำตอบตัวสำรอง ไม่ส่งครึ่งประโยค', (await aiMod.chatReply([{ role: 'user', type: 'text', text: 'ราคา', ts: new Date().toISOString() }], {})) === 'เสื้อยืดตัวละ 290 บาทค่ะ');
    aiMod.setClient(null);
  }

  // ===== ฐานข้อมูล: เลือกไฟล์ / Turso =====
  check('ไม่ตั้งอะไร = ไฟล์ chatbot.db ข้างโปรเจกต์', db.dbUrl({}).startsWith('file:') && db.dbUrl({}).endsWith('chatbot.db'));
  check('DB_PATH = ไฟล์ตามที่ชี้ (Railway volume)', db.dbUrl({ DB_PATH: '/data/chatbot.db' }) === 'file:/data/chatbot.db');
  check('DATABASE_URL = Turso (Vercel) ชนะ DB_PATH', db.dbUrl({ DATABASE_URL: 'libsql://x.turso.io', DB_PATH: '/data/a.db' }) === 'libsql://x.turso.io');

  // ===== เซิร์ฟเวอร์จริง (Express) — health / ลายเซ็น / webhook =====
  {
    const crypto = require('crypto');
    const { app } = require('../src/app');
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await (await fetch(`${base}/health`)).json();
    check('/health ตอบ ok + บอกว่าใช้ฐานข้อมูลแบบไหน', health.ok === true && health.db === 'file');
    const bad = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': 'wrong' }, body: '{"events":[]}' });
    check('ลายเซ็นผิด → 401 (ไม่ใช่ 500)', bad.status === 401);
    const lid = `wh-${Date.now()}`;
    await db.logMessage('U-wh', 'user', lid, 'text', 'จะถูกลบ');
    const body = JSON.stringify({ destination: 'x', events: [{ type: 'unsend', source: { type: 'user', userId: 'U-wh' }, unsend: { messageId: lid } }] });
    const sig = crypto.createHmac('sha256', 'test-secret').update(body).digest('base64');
    const ok = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': sig }, body });
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) { await new Promise((r) => setTimeout(r, 50)); gone = !(await q1('SELECT 1 FROM messages WHERE line_msg_id = ?', [lid])); }
    check('webhook ลายเซ็นถูก → 200 แล้วทำงานเบื้องหลังจนเสร็จ', ok.status === 200 && gone);
    const backup = await fetch(`${base}/admin/backup?key=wrong`);
    check('/admin/backup ไม่มีรหัส → 403', backup.status === 403);
    server.close();
  }

  console.log(`\n${pass} ผ่าน / ${fail} พัง`);
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('❌ เทสล้ม:', e.stack); process.exit(1); });
