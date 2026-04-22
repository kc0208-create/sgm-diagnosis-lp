require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ルートアクセス → diagnosis.html にリダイレクト
app.get('/', (req, res) => res.redirect('/diagnosis.html'));

const PORT = process.env.PORT || 3000;

// ===== 環境変数チェック =====
const hasEnv = (key) => !!process.env[key];

// ===== MySQL接続 =====
let db = null;
if (hasEnv('DB_HOST') && hasEnv('DB_USER') && hasEnv('DB_PASS') && hasEnv('DB_NAME')) {
  try {
    const mysql = require('mysql2/promise');
    db = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
    });
    console.log('[DB] MySQL pool created');
  } catch (e) {
    console.warn('[DB] MySQL init failed:', e.message);
  }
}

// ===== LINE SDK =====
let lineClient = null;
if (hasEnv('LINE_CHANNEL_ACCESS_TOKEN')) {
  try {
    const line = require('@line/bot-sdk');
    lineClient = new line.messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
    console.log('[LINE] Client initialized');
  } catch (e) {
    console.warn('[LINE] Init failed:', e.message);
  }
}

// ===== Google Auth =====
let googleAuth = null;
if (hasEnv('GOOGLE_CLIENT_ID') && hasEnv('GOOGLE_CLIENT_SECRET') && hasEnv('GOOGLE_REFRESH_TOKEN')) {
  try {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    googleAuth = oauth2Client;
    console.log('[Google] Auth initialized');
  } catch (e) {
    console.warn('[Google] Auth init failed:', e.message);
  }
}

// ===== Nodemailer =====
let mailer = null;
if (hasEnv('SMTP_HOST') && hasEnv('SMTP_USER') && hasEnv('SMTP_PASS')) {
  try {
    const nodemailer = require('nodemailer');
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    console.log('[Mail] Transporter initialized');
  } catch (e) {
    console.warn('[Mail] Init failed:', e.message);
  }
}

// ===== インメモリ診断データストア（DB未設定時のフォールバック）=====
const diagnosisStore = new Map();

// ===== ヘルパー関数 =====

async function saveDiagnosis(data) {
  const id = uuidv4();
  const record = { id, ...data, createdAt: new Date().toISOString() };
  diagnosisStore.set(id, record);

  if (db) {
    try {
      await db.execute(
        `INSERT INTO diagnoses (id, answers, results, created_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE results = VALUES(results)`,
        [id, JSON.stringify(data.answers || {}), JSON.stringify(data.results || {})]
      );
    } catch (e) {
      console.warn('[DB] Insert failed (using memory store):', e.message);
    }
  }
  return id;
}

function getDiagnosis(id) {
  return diagnosisStore.get(id) || null;
}

function buildLineMessage(results) {
  const { monthlyProfit, yearlyProfit, score, weeklyTimeSaved, improveRate, label } = results;
  const scoreLabel =
    score >= 50
      ? 'AIを雇うことで、24時間の自由と利益を同時に手にする準備ができています。一人完結の究極の副業スタイルの完成です。'
      : score >= 30
      ? '独学の限界を突破するタイミングです。AIをパートナーにすることで、学習時間を利益に変えることができます。'
      : 'まずはAIという「最強の部下」を持つメリットを体験しましょう。あなたの時間はもっと価値あることに使えるはずです。';

  return [
    {
      type: 'text',
      text: `━━━━━━━━━━━━━━━━━━━━
🤖 Sagemaster AI診断結果
━━━━━━━━━━━━━━━━━━━━

【AI適合度スコア】
✅ ${score}点 / 60点

【月間潜在利益向上額】
💰 ¥${monthlyProfit.toLocaleString()}

【年間潜在利益向上額】
🚀 ¥${yearlyProfit.toLocaleString()}

【週間削減時間】
⏰ 約${weeklyTimeSaved}時間

【利益向上レンジ】
📈 +${Math.round(improveRate * 100)}%

━━━━━━━━━━━━━━━━━━━━
${scoreLabel}
━━━━━━━━━━━━━━━━━━━━

👇 Sagemasterの詳細はこちら`,
    },
    {
      type: 'template',
      altText: 'Sagemaster 特別案内',
      template: {
        type: 'buttons',
        title: '🎁 特別ご案内',
        text: 'Sagemasterの無料デモを体験してみませんか？',
        actions: [
          {
            type: 'uri',
            label: '無料デモを予約する',
            uri: process.env.FRONTEND_URL
              ? `${process.env.FRONTEND_URL}/diagnosis2.html`
              : 'https://example.com/diagnosis2.html',
          },
        ],
      },
    },
  ];
}

async function createCalendarEvent(data) {
  if (!googleAuth) throw new Error('Google auth not configured');
  const { google } = require('googleapis');
  const calendar = google.calendar({ version: 'v3', auth: googleAuth });

  const startTime = new Date(data.slot);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

  const event = {
    summary: `【Sagemaster】${data.contactName}様 無料デモ`,
    description: `
お名前: ${data.contactName}
メール: ${data.email}
選択プラン: ${data.selectedPlan || '未選択'}
スコア: ${data.score || '-'}点
月間潜在利益向上額: ¥${data.monthlyProfit ? data.monthlyProfit.toLocaleString() : '-'}
${data.freeText ? '\nメッセージ:\n' + data.freeText : ''}
    `.trim(),
    start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Tokyo' },
    end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Tokyo' },
    attendees: [{ email: data.email, displayName: data.contactName }],
    conferenceData: {
      createRequest: { requestId: uuidv4(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    },
  };

  const response = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    resource: event,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
  });

  return response.data;
}

async function getAvailableSlots() {
  if (!googleAuth) {
    // フォールバック: 固定の空き枠を返す
    return generateDefaultSlots();
  }

  const { google } = require('googleapis');
  const calendar = google.calendar({ version: 'v3', auth: googleAuth });

  const now = new Date();
  const tenDaysLater = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

  const freeBusyResponse = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: tenDaysLater.toISOString(),
      timeZone: 'Asia/Tokyo',
      items: [{ id: process.env.GOOGLE_CALENDAR_ID || 'primary' }],
    },
  });

  const busySlots = freeBusyResponse.data.calendars[
    process.env.GOOGLE_CALENDAR_ID || 'primary'
  ].busy || [];

  return generateSlots(now, tenDaysLater, busySlots);
}

function generateDefaultSlots() {
  const slots = [];
  const now = new Date();
  for (let d = 1; d <= 10; d++) {
    const date = new Date(now);
    date.setDate(now.getDate() + d);
    const dateStr = date.toLocaleDateString('ja-JP', {
      month: 'numeric', day: 'numeric', weekday: 'short'
    });
    const daySlots = [];
    for (let h = 11; h <= 23; h++) {
      const slot = new Date(date);
      slot.setHours(h, 0, 0, 0);
      daySlots.push({
        iso: slot.toISOString(),
        label: `${h}:00`,
      });
    }
    slots.push({ date: dateStr, slots: daySlots });
  }
  return slots;
}

function generateSlots(from, to, busySlots) {
  const slots = [];
  const current = new Date(from);
  current.setMinutes(0, 0, 0);
  if (current.getHours() >= 23) current.setDate(current.getDate() + 1);

  const dayMap = new Map();

  while (current < to) {
    const h = current.getHours();
    if (h >= 11 && h <= 23) {
      const isBusy = busySlots.some((busy) => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return current >= busyStart && current < busyEnd;
      });

      if (!isBusy) {
        const dateKey = current.toLocaleDateString('ja-JP', {
          month: 'numeric', day: 'numeric', weekday: 'short',
        });
        if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
        dayMap.get(dateKey).push({
          iso: current.toISOString(),
          label: `${String(h).padStart(2, '0')}:00`,
        });
      }
    }
    current.setHours(current.getHours() + 1);
  }

  dayMap.forEach((daySlots, date) => slots.push({ date, slots: daySlots }));
  return slots;
}

async function sendEmails(data, calendarEvent) {
  if (!mailer) throw new Error('Mailer not configured');

  const meetUrl = calendarEvent?.conferenceData?.entryPoints?.[0]?.uri || '（調整中）';
  const slotStr = new Date(data.slot).toLocaleString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo',
  });

  // ユーザーへの確認メール
  await mailer.sendMail({
    from: `Sagemaster <${process.env.SMTP_USER}>`,
    to: data.email,
    subject: '【Sagemaster】無料デモのご予約を承りました',
    html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
  <h2 style="color:#007FFF;">Sagemaster 無料デモご予約確認</h2>
  <p>${data.contactName} 様</p>
  <p>以下の内容でご予約を承りました。</p>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">日時</td><td style="padding:8px;border:1px solid #ddd;">${slotStr}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">プラン</td><td style="padding:8px;border:1px solid #ddd;">${data.selectedPlan || '未選択'}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">Google Meet</td><td style="padding:8px;border:1px solid #ddd;"><a href="${meetUrl}">${meetUrl}</a></td></tr>
  </table>
  <p style="margin-top:20px;">当日はこちらのMeetリンクからご参加ください。</p>
</div>
    `,
  });

  // 管理者への通知メール
  await mailer.sendMail({
    from: `SGM Notify <${process.env.SMTP_USER}>`,
    to: process.env.ADMIN_EMAIL,
    subject: `【新規予約】${data.contactName}様 ${slotStr}`,
    html: `
<h3>新規デモ予約が入りました</h3>
<p>氏名: ${data.contactName}</p>
<p>メール: ${data.email}</p>
<p>日時: ${slotStr}</p>
<p>プラン: ${data.selectedPlan || '-'}</p>
<p>Meet: <a href="${meetUrl}">${meetUrl}</a></p>
<p>スコア: ${data.score || '-'}点</p>
<p>月間利益向上額: ¥${data.monthlyProfit ? Number(data.monthlyProfit).toLocaleString() : '-'}</p>
${data.freeText ? `<p>メッセージ: ${data.freeText}</p>` : ''}
    `,
  });
}

async function sendMetaConversion(data) {
  if (!hasEnv('META_ACCESS_TOKEN') || !hasEnv('META_PIXEL_ID')) throw new Error('Meta not configured');
  const axios = require('axios');

  const eventData = {
    data: [
      {
        event_name: 'CompleteRegistration',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        user_data: {
          em: [data.email ? require('crypto').createHash('sha256').update(data.email.toLowerCase()).digest('hex') : null],
        },
        custom_data: {
          content_name: 'Sagemaster Demo Booking',
          plan: data.selectedPlan,
        },
      },
    ],
  };

  if (process.env.META_TEST_EVENT_CODE) {
    eventData.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.META_PIXEL_ID}/events`,
    eventData,
    { params: { access_token: process.env.META_ACCESS_TOKEN } }
  );
}

async function sendGoogleConversion(data) {
  // Google Sheets経由でオフラインコンバージョン記録（簡易版）
  // 本番ではGoogle Ads APIを使用
  console.log('[GoogleConv] Conversion recorded (stub):', data.email);
}

async function sendSlackNotification(data, calendarEvent) {
  if (!hasEnv('SLACK_BOT_TOKEN') || !hasEnv('SLACK_CHANNEL_ID')) throw new Error('Slack not configured');
  const axios = require('axios');

  const meetUrl = calendarEvent?.conferenceData?.entryPoints?.[0]?.uri || '-';
  const slotStr = new Date(data.slot).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  await axios.post(
    'https://slack.com/api/chat.postMessage',
    {
      channel: process.env.SLACK_CHANNEL_ID,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🎉 新規デモ予約！', emoji: true },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*氏名:*\n${data.contactName}` },
            { type: 'mrkdwn', text: `*メール:*\n${data.email}` },
            { type: 'mrkdwn', text: `*日時:*\n${slotStr}` },
            { type: 'mrkdwn', text: `*プラン:*\n${data.selectedPlan || '-'}` },
            { type: 'mrkdwn', text: `*スコア:*\n${data.score || '-'}点` },
            { type: 'mrkdwn', text: `*月間利益向上:*\n¥${data.monthlyProfit ? Number(data.monthlyProfit).toLocaleString() : '-'}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Meet URL:*\n${meetUrl}` },
        },
      ],
    },
    { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
  );
}

// ===== APIエンドポイント =====

// ウォームアップ用
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 診断データ保存
app.post('/api/diagnosis', async (req, res) => {
  try {
    const { answers, results } = req.body;
    const id = await saveDiagnosis({ answers, results });
    res.json({ success: true, diagnosisId: id });
  } catch (e) {
    console.error('[/api/diagnosis]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// LINE push message送信
app.post('/api/line-send', async (req, res) => {
  try {
    const { userId, diagnosisId } = req.body;
    if (!userId || !diagnosisId) {
      return res.status(400).json({ success: false, error: 'userId and diagnosisId required' });
    }

    const diagnosis = getDiagnosis(diagnosisId);
    if (!diagnosis) {
      return res.status(404).json({ success: false, error: 'Diagnosis not found' });
    }

    if (!lineClient) {
      console.warn('[LINE] Client not configured, skipping push');
      return res.json({ success: true, skipped: true });
    }

    const messages = buildLineMessage(diagnosis.results);
    await lineClient.pushMessage({ to: userId, messages });

    res.json({ success: true });
  } catch (e) {
    console.error('[/api/line-send]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// カレンダー空き枠取得
app.get('/api/slots', async (req, res) => {
  try {
    const slots = await getAvailableSlots();
    res.json({ success: true, slots });
  } catch (e) {
    console.error('[/api/slots]', e.message);
    // フォールバック
    res.json({ success: true, slots: generateDefaultSlots() });
  }
});

// カレンダー予約（diagnosis2.htmlの前段保存用）
app.post('/api/book', async (req, res) => {
  try {
    const calEvent = await createCalendarEvent(req.body);
    res.json({ success: true, meetUrl: calEvent?.conferenceData?.entryPoints?.[0]?.uri || null });
  } catch (e) {
    console.error('[/api/book]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// フォームCV送信（6並列処理）
app.post('/api/form-submit', async (req, res) => {
  const data = req.body;

  let calendarEvent = null;

  // カレンダー作成は先に行い、Meet URLをメールに含める
  try {
    calendarEvent = await createCalendarEvent(data);
  } catch (e) {
    console.warn('[Calendar] Failed:', e.message);
  }

  // 残り5処理を並列実行（失敗しても全体は継続）
  const results = await Promise.allSettled([
    saveDiagnosis({ answers: data, results: { score: data.score, monthlyProfit: data.monthlyProfit } }),
    sendEmails(data, calendarEvent),
    sendMetaConversion(data),
    sendGoogleConversion(data),
    sendSlackNotification(data, calendarEvent),
  ]);

  const errors = results
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason?.message || 'unknown');

  if (errors.length > 0) {
    console.warn('[form-submit] Some parallel tasks failed:', errors);
  }

  res.json({
    success: true,
    meetUrl: calendarEvent?.conferenceData?.entryPoints?.[0]?.uri || null,
    warnings: errors.length > 0 ? errors : undefined,
  });
});

// ===== サーバー起動 =====
app.listen(PORT, () => {
  console.log(`\n🚀 Sagemaster Diagnosis API Server`);
  console.log(`   Running on: http://localhost:${PORT}`);
  console.log(`   diagnosis.html : http://localhost:${PORT}/diagnosis.html`);
  console.log(`   diagnosis2.html: http://localhost:${PORT}/diagnosis2.html`);
  console.log(`   liff.html      : http://localhost:${PORT}/liff.html\n`);
});
