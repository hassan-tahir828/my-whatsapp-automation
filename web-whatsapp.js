// web-whatsapp.js
// ZareaAI — Multi-user WhatsApp backend (Flood-Proof v7: QR Timeout Fix)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require("whatsapp-web.js");
const admin = require("firebase-admin");
const crypto = require("crypto");
const fs = require("fs"); 

const PORT = process.env.PORT || 4000;
const RAW_MESSAGES_COLLECTION = "raw_messages";
const clients = {}; // { userId: clientInstance }
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const QR_TIMEOUT_MS = 60000; // 60 seconds

// -------------------------
// 🔥 FIREBASE INITIALIZATION
// -------------------------
let db;
let rawMessagesCollection;

async function initializeFirebase() {
  try {
    // SECURITY CHECK: Ensure ENCRYPTION_KEY is a 64-character hex string (32 bytes)
    if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY)) {
      throw new Error("Missing or invalid ENCRYPTION_KEY. Must be a 64-character hexadecimal string.");
    }
    const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!base64Key) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64");

    const decoded = Buffer.from(base64Key, "base64").toString("utf-8");
    const serviceAccount = JSON.parse(decoded);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();
    rawMessagesCollection = db.collection(RAW_MESSAGES_COLLECTION);

    console.log("🔥 Firebase Admin Initialized");
  } catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
    process.exit(1);
  }
}

// -------------------------
// 🔒 ENCRYPTION HELPER
// -------------------------
function encrypt(text) {
  if (!text) return { encryptedBody: null, iv: null, authTag: null };

  const key = Buffer.from(ENCRYPTION_KEY, 'hex'); // Use 'hex' encoding
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(text, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encryptedBody: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag,
  };
}


// -------------------------
// 🔥 UPDATE WHATSAPP SESSION STATUS
// -------------------------
async function updateFirestoreStatus(userId, data) {
  try {
    if (!db) return;
    const doc = db.collection("whatsapp_sessions").doc(userId);
    await doc.set({ ...data, userId }, { merge: true });
    console.log(`✅ Updated session status → ${userId}`);
  } catch (err) {
    console.error("⚠️ Firestore Update Error:", err);
  }
}

// -------------------------
// 🔥 SAVE RAW MESSAGE (ENCRYPTED)
// -------------------------
async function saveRawMessage(msg, userId) {
  try {
    const encryptedData = encrypt(msg.body);

    const data = {
      timestamp: admin.firestore.Timestamp.now(),
      userId,
      from: msg.from,
      to: msg.to,
      encryptedBody: encryptedData.encryptedBody,
      iv: encryptedData.iv,
      authTag: encryptedData.authTag,
      type: msg.type,
      phoneNumber: msg.from.split("@")[0],
      wwebId: msg.id._serialized,
      isGroup: false,
      processing: false,
      processed: false,
      isLead: null,
      replyPending: false,
      autoReplyText: null,
    };

    const docRef = await rawMessagesCollection.add(data);
    console.log(`📩 [${userId}] Saved encrypted message → ${docRef.id.substring(0, 8)}...`);
  } catch (err) {
    console.error(`❌ Error saving message for ${userId}:`, err);
  }
}

// -------------------------
// 🤖 AI REPLY EXECUTOR WATCHER
// -------------------------
function startAiReplyExecutor() {
  if (!db) return;

  const q = db.collection(RAW_MESSAGES_COLLECTION).where("replyPending", "==", true);

  console.log("🤖 AI Reply Executor Started");

  q.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (!["added", "modified"].includes(change.type)) return;

      const doc = change.doc;
      const d = doc.data();

      if (!d.autoReplyText || !d.from || !d.userId) return;

      const client = clients[d.userId];
      if (!client) return;

      try {
        // Update to handle the 'ready' event for a new client start, if needed, 
        // but for ongoing clients, this is fine.
        await client.sendMessage(d.from, d.autoReplyText);

        await doc.ref.update({
          replyPending: false,
          replySentAt: admin.firestore.Timestamp.now(),
        });

        console.log(`🤖 [${d.userId}] AI reply sent → ${doc.id}`);
      } catch (err) {
        console.error(`❌ Error sending AI reply (${doc.id}):`, err.message);
      }
    });
  });
}

// -------------------------
// 🔥 BULLETPROOF MESSAGE HANDLER
// -------------------------
async function handleInboundMessage(msg, userId) {
  try {
    const jid = msg.from || "";
    const body = msg.body?.trim() || "";

    const isGroupLike =
      msg.isGroup ||
      jid.endsWith("@g.us") ||
      jid.includes("community") ||
      jid.includes("@broadcast") ||
      jid.includes("newsletter") ||
      jid.includes("@temp");

    if (isGroupLike) {
      console.log(`🚫 [${userId}] Ignored GROUP-like → ${jid}`);
      return;
    }

    if (msg.fromMe) {
      console.log(`⚠️ Ignored echo from self`);
      return;
    }

    if (!body || body.length < 1) {
      console.log(`⚠️ Ignored empty body`);
      return;
    }

    if (["sticker", "location", "audio", "video", "image"].includes(msg.type)) {
      console.log(`⚠️ Skipped media message type=${msg.type}`);
      return;
    }

    await saveRawMessage(msg, userId);
  } catch (err) {
    console.error("❌ Inbound Handler Error:", err);
  }
}

// -------------------------
// 🔥 CLIENT EVENT LISTENERS
// -------------------------
function setupClientListeners(client, userId) {
  client.on("qr", (qr) => {
    updateFirestoreStatus(userId, {
      qr,
      connected: false,
      status: "awaiting_scan",
    });
    console.log(`🤖 [${userId}] QR Generated`);
  });

  client.on("ready", () => {
    const phone = client.info.wid.user;
    updateFirestoreStatus(userId, {
      qr: null,
      connected: true,
      status: "active",
      phoneNumber: phone,
    });
    console.log(`🎉 [${userId}] WhatsApp Ready (${phone})`);
  });

  client.on("message", async (msg) => {
    await handleInboundMessage(msg, userId);
  });

  client.on("disconnected", (reason) => {
    console.log(`🛑 [${userId}] Disconnected → ${reason}`);
    updateFirestoreStatus(userId, {
      connected: false,
      status: "disconnected",
    });
    delete clients[userId];
  });

  client.on("auth_failure", () => {
    updateFirestoreStatus(userId, {
      connected: false,
      status: "auth_failed",
    });
    console.log(`⚠️ [${userId}] AUTH FAILED`);
  });
}

// -------------------------
// 🔥 CREATE WHATSAPP CLIENT WITH QR TIMEOUT (FIXED)
// -------------------------
async function createClient(userId) {
  if (clients[userId]) return clients[userId];

  const AUTH_PATH = process.env.WWEBJS_AUTH_DIR || "/app/data/.wwebjs_auth";

  // Ensure the directory exists and has correct permissions
  if (!fs.existsSync(AUTH_PATH)) {
    fs.mkdirSync(AUTH_PATH, { recursive: true });
  }
  try {
      fs.chmodSync(AUTH_PATH, 0o777);
  } catch(e) {
      console.log(`⚠️ Could not set permissions on ${AUTH_PATH}. May cause issues.`);
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: userId,
      dataPath: AUTH_PATH,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
    },
  });

  setupClientListeners(client, userId);

  try {
    // 1. Define the timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`QR_TIMEOUT: Client ${userId} failed to scan QR after ${QR_TIMEOUT_MS / 1000}s.`));
      }, QR_TIMEOUT_MS);
    });
    
    // 2. Race the initialize call against the timeout
    await Promise.race([
        client.initialize(), 
        timeoutPromise
    ]);

    console.log(`🚀 Initialized WhatsApp → ${userId}`);
    clients[userId] = client;
    return client;

  } catch (err) {
    console.error(`❌ Error initializing client (${userId}):`, err.message);
    
    // Cleanup: Destroy the client and remove from map
    try {
      if (clients[userId]) delete clients[userId];
      await client.destroy();
    } catch (destroyErr) {
      console.log(`⚠️ Ignore error during client.destroy(): ${destroyErr.message}`);
    }

    // Update session status based on error type
    updateFirestoreStatus(userId, {
      status: err.message.includes('QR_TIMEOUT') ? "qr_timeout" : "init_failed",
      qr: null,
      connected: false
    });
    
    // Re-throw the error so the calling Express endpoint doesn't hang
    throw err;
  }
}

// -------------------------
// 🌍 EXPRESS SERVER
// -------------------------
const app = express();
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());

// Start WhatsApp client
app.post("/start-whatsapp", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    await createClient(userId);
    res.json({ message: `Client started for ${userId}` });
  } catch (e) {
    // Catch the error thrown by createClient (including QR_TIMEOUT)
    res.status(500).json({ error: e.message });
  }
});

// Disconnect client
app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  const client = clients[userId];
  if (!client) return res.status(400).json({ error: "Not running" });

  try {
      await client.logout();
      await client.destroy(); // Ensure the browser process is killed
  } catch (e) {
      console.error(`⚠️ Error during client logout/destroy: ${e.message}`);
  }
  
  delete clients[userId];

  res.json({ message: `Client ${userId} disconnected.` });
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ZareaAI WhatsApp Backend Running",
    activeClients: Object.keys(clients).length,
    timestamp: new Date().toISOString(),
  });
});

// -------------------------
// 🚀 FINAL INIT
// -------------------------
(async () => {
  await initializeFirebase();
  startAiReplyExecutor();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌍 Server Running on port ${PORT}`);
  });
})();
