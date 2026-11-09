// เปิดเซิร์ฟเวอร์ปกติ — Railway / เครื่องตัวเอง (บน Vercel ใช้ api/index.js แทน)
require('dotenv').config();
const { app, startup } = require('./app');
const branding = require('./branding');

const port = process.env.PORT || 3000;
startup()
  .then(() => app.listen(port, () => console.log(`${branding.BOT} (line-chatbot) ฟังอยู่ที่พอร์ต ${port}`)))
  .catch((e) => {
    console.error('❌ บูตไม่ผ่าน:', e.message);
    process.exit(1);
  });
