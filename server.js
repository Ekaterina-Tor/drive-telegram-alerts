import express from "express";
import axios from "axios";
import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const drive = google.drive({
  version: "v3",
  auth: oauth2Client,
});

let pageToken = null;

async function sendTelegram(text) {
  await axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
    }
  );
}

async function initPageToken() {
  const response = await drive.changes.getStartPageToken();
  pageToken = response.data.startPageToken;
  console.log("Start token:", pageToken);
}

app.post("/google-drive-webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const changes = await drive.changes.list({
      pageToken,
      fields:
        "changes(fileId,file(name,webViewLink,modifiedTime)),newStartPageToken",
    });

    for (const change of changes.data.changes || []) {
      const file = change.file;

      if (!file) continue;

      await sendTelegram(
        `📁 Изменение в Google Drive\n\n${file.name}\n${file.webViewLink || ""}`
      );
    }

    if (changes.data.newStartPageToken) {
      pageToken = changes.data.newStartPageToken;
    }
  } catch (e) {
    console.error(e);
  }
});

app.get("/", (req, res) => {
  res.send("OK");
});

const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log(`Server started on ${port}`);
  await initPageToken();
});
