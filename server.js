import express from "express";
import axios from "axios";
import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_CHAT_IDS,
  PUBLIC_WEBHOOK_URL,
  GOOGLE_CHANNEL_TOKEN,
  TARGET_FOLDER_ID,
  PORT
} = process.env;

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: GOOGLE_REFRESH_TOKEN
});

const drive = google.drive({ version: "v3", auth: oauth2Client });

let pageToken = null;
let isProcessing = false;

const processedEvents = new Set();

function rememberEvent(key) {
  processedEvents.add(key);

  setTimeout(() => {
    processedEvents.delete(key);
  }, 24 * 60 * 60 * 1000);
}

function escapeHtml(text = "") {
  return String(text).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[c]);
}

function getTelegramChatIds() {
  if (TELEGRAM_CHAT_IDS) {
    return TELEGRAM_CHAT_IDS
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }

  return [TELEGRAM_CHAT_ID].filter(Boolean);
}

async function sendTelegram(message) {
  for (const chatId of getTelegramChatIds()) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: false
        }
      );
    } catch (error) {
      console.error(
        `Telegram send error for ${chatId}:`,
        error.response?.data || error.message
      );
    }
  }
}

function detectChange(file, removed) {
  if (removed) return "файл удалён или доступ к нему потерян";
  if (file.trashed) return "файл перемещён в корзину";

  const created = new Date(file.createdTime).getTime();
  const modified = new Date(file.modifiedTime).getTime();

  if (Math.abs(modified - created) < 15000) {
    return "создан новый файл";
  }

  return "обновлён файл";
}

async function initPageToken() {
  const res = await drive.changes.getStartPageToken({
    supportsAllDrives: true
  });

  pageToken = res.data.startPageToken;
  console.log("Start page token:", pageToken);
}

async function watchDriveChanges() {
  if (!pageToken) await initPageToken();

  const res = await drive.changes.watch({
    pageToken,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    requestBody: {
      id: uuidv4(),
      type: "web_hook",
      address: PUBLIC_WEBHOOK_URL,
      token: GOOGLE_CHANNEL_TOKEN,
      expiration: Date.now() + 6 * 24 * 60 * 60 * 1000
    }
  });

  console.log("Drive watch created:", res.data.id);
}

async function processDriveChanges() {
  if (isProcessing) {
    console.log("Already processing, skipping duplicate webhook");
    return;
  }

  isProcessing = true;

  try {
    if (!pageToken) await initPageToken();

    let currentToken = pageToken;

    while (currentToken) {
      const res = await drive.changes.list({
        pageToken: currentToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        fields:
          "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,webViewLink,createdTime,modifiedTime,trashed,parents))"
      });

      for (const change of res.data.changes || []) {
        const file = change.file;

        if (change.removed || !file) {
          const deleteKey = `removed:${change.fileId}`;

          if (processedEvents.has(deleteKey)) continue;
          rememberEvent(deleteKey);

          await sendTelegram(
            `🗑 <b>Google Drive: изменение</b>\n\n` +
            `Что изменилось: файл удалён или доступ потерян\n` +
            `File ID: <code>${escapeHtml(change.fileId)}</code>`
          );

          continue;
        }

        if (file.mimeType === "application/vnd.google-apps.folder") {
          console.log("Folder ignored:", file.name);
          continue;
        }

        if (
    TARGET_FOLDER_ID &&
    (!file.parents || !file.parents.includes(TARGET_FOLDER_ID))
  ) {
    console.log("Outside target folder ignored:", file.name);
    continue;
  }

        const eventKey = `${file.id}:${file.modifiedTime}:${file.trashed}`;

        if (processedEvents.has(eventKey)) {
          console.log("Duplicate ignored:", file.name);
          continue;
        }

        rememberEvent(eventKey);

        const whatChanged = detectChange(file, change.removed);

        await sendTelegram(
          `📄 <b>Google Drive: изменение</b>\n\n` +
          `Что изменилось: <b>${escapeHtml(whatChanged)}</b>\n` +
          `Название: <b>${escapeHtml(file.name)}</b>\n` +
          `Тип: <code>${escapeHtml(file.mimeType)}</code>\n` +
          `Изменён: ${escapeHtml(file.modifiedTime || "неизвестно")}\n` +
          `${file.webViewLink ? `Ссылка: ${file.webViewLink}` : ""}`
        );
      }

      if (res.data.nextPageToken) {
        currentToken = res.data.nextPageToken;
      } else {
        pageToken = res.data.newStartPageToken;
        currentToken = null;
      }
    }
  } finally {
    isProcessing = false;
  }
}

app.get("/", (req, res) => {
  res.send("Drive Telegram Alerts is running");
});

app.get("/test-telegram", async (req, res) => {
  await sendTelegram("✅ Тестовое сообщение: бот подключён.");
  res.send("Telegram test sent");
});

app.get("/setup-watch", async (req, res) => {
  await watchDriveChanges();
  res.send("Google Drive watch created");
});

app.post("/google-drive-webhook", async (req, res) => {
  const token = req.header("X-Goog-Channel-Token");
  const state = req.header("X-Goog-Resource-State");

  if (GOOGLE_CHANNEL_TOKEN && token !== GOOGLE_CHANNEL_TOKEN) {
    console.log("Old or invalid webhook ignored");
    return res.sendStatus(204);
  }

  res.sendStatus(204);

  console.log("Webhook received:", state);

  if (state === "sync") return;

  try {
    await processDriveChanges();
  } catch (error) {
    console.error(
      "Webhook processing error:",
      error.response?.data || error.message
    );
  }
});

const port = PORT || 3000;

app.listen(port, async () => {
  console.log(`Server started on ${port}`);

  await initPageToken();
  await watchDriveChanges();

  setInterval(watchDriveChanges, 6 * 24 * 60 * 60 * 1000);
});
