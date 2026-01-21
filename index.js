import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { readPage } from "./scraper.js";
import XLSX from "xlsx";
import mongoose from "mongoose";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const CONTACT_DETAILS = `
<br><br>
📞 <b>Phone:</b>1300845156<br>
📧 <b>Email:</b> <a href="mailto:info@greenfieldsre.com.au">info@greenfieldsre.com.au</a>
`;

/* =========================
   MONGODB CONNECTION
========================= */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB error", err);
    process.exit(1);
  });

/* =========================
   CHAT SCHEMA
========================= */
const chatSchema = new mongoose.Schema(
  {
    sessionId: String,
    userMessage: String,
    botReply: String,
    source: {
      type: String,
      enum: [
        "lead_request",
        "lead_capture",
        "clarification",
        "listing_rule",
        "ai"
      ]
    },
    leadContact: String,
    leadCaptured: {
      type: Boolean,
      default: false
    },
    awaitingClarification: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

const Chat = mongoose.model("Chat", chatSchema);

/* =========================
   OPENAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   LOAD TXT TRAINING FILES
========================= */
const trainingPath = path.join(process.cwd(), "training");

const txtTraining = `
${fs.readFileSync(`${trainingPath}/company.txt`, "utf8")}
${fs.readFileSync(`${trainingPath}/services.txt`, "utf8")}
${fs.readFileSync(`${trainingPath}/rules.txt`, "utf8")}
`;

/* =========================
   LOAD EXCEL FAQ
========================= */
const faqFilePath = path.join(process.cwd(), "Greenfields_AI_Chatbot_FINAL.xlsx");
const workbook = XLSX.readFile(faqFilePath);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet);

let faqTraining = "FAQ KNOWLEDGE:\n";

rows.forEach((row) => {
  if (row["User Question"] && row["Bot Answer"]) {
    faqTraining += `
Q: ${row["User Question"]}
A: ${row["Bot Answer"]}
`;
  }
});

/* =========================
   WEBSITE AUTO READ (OPTIONAL)
========================= */
const WEBSITE_PAGES = [
  "https://greenfieldsre.com.au/",
  "https://greenfieldsre.com.au/about",
  "https://greenfieldsre.com.au/contact"
];

let websiteTraining = "";

(async () => {
  for (const url of WEBSITE_PAGES) {
    const text = await readPage(url);
    if (text) {
      websiteTraining += `\n\nContent from ${url}:\n${text}`;
    }
  }

  if (!websiteTraining) {
    console.log("⚠️ Website scraping skipped (local DNS issue)");
  } else {
    console.log("✅ Website content loaded");
  }
})();

/* =========================
   LISTING LINKS
========================= */
const LISTING_LINKS = [
  {
    keywords: ["business sales", "business for sale"],
    url: "https://greenfieldsre.com.au/business-sales/"
  },
  {
    keywords: ["for sale", "buy property", "purchase property"],
    url: "https://greenfieldsre.com.au/for-sale-properties/"
  },
  {
    keywords: ["for lease", "rent property", "rental property"],
    url: "https://greenfieldsre.com.au/for-lease-properties/"
  },
  {
    keywords: ["acreage for sale", "farmland for sale", "rural land"],
    url: "https://greenfieldsre.com.au/acreage/"
  }
];

const GENERAL_LISTINGS_URL = "https://greenfieldsre.com.au/for-sale-properties/";

/* =========================
   INTENT + HELPERS
========================= */
function hasListingIntent(message) {
  const intentWords = [
    "show",
    "view",
    "find",
    "available",
    "listings",
    "properties",
    "buy",
    "purchase",
    "rent",
    "lease"
  ];
  const text = message.toLowerCase();
  return intentWords.some(w => text.includes(w));
}

function isAmbiguousQuery(message) {
  const terms = [
    "psp",
    "ugz",
    "englobo",
    "zoning",
    "planning",
    "land"
  ];
  const text = message.toLowerCase();
  return terms.some(t => text.includes(t));
}

function isClarificationAnswer(message) {
  const text = message.toLowerCase();
  return (
    text.includes("listing") ||
    text.includes("listings") ||
    text.includes("yes") ||
    text.includes("show") ||
    text.includes("available")
  );
}

function detectListingLink(message) {
  const text = message.toLowerCase();

  if (!hasListingIntent(text)) return null;

  for (const item of LISTING_LINKS) {
    if (item.keywords.some(k => text.includes(k))) {
      return item.url;
    }
  }

  return GENERAL_LISTINGS_URL;
}

function looksLikeContactInfo(message) {
  const phoneRegex = /\b\d{9,12}\b/;
  const emailRegex = /\S+@\S+\.\S+/;
  return phoneRegex.test(message) || emailRegex.test(message);
}

/* =========================
   CHAT ENDPOINT
========================= */
app.post("/chat", async (req, res) => {
  try {
   const { message, sessionId } = req.body; // ✅ ADDED sessionId
    if (!message || !sessionId)
      return res.status(400).json({ error: "Message & sessionId required" });

    /* 🔥 LEAD FIRST (SESSION BASED) */
    const leadExists = await Chat.findOne({ sessionId,leadCaptured: true });

    if (!leadExists) {
      if (looksLikeContactInfo(message)) {
        const reply =
          "Thank you! Our team will reach out to you shortly. How can I assist you today?";

        await Chat.create({
          sessionId,  
          userMessage: message,
          botReply: reply,
          source: "lead_capture",
          leadContact: message,
          leadCaptured: true
        });

        return res.json({ reply });
      }

      const reply =
        "Hi 👋 Welcome to Green Fields Real Estate! To help you better, could you please share your contact number or email?";

      await Chat.create({
        sessionId,
        userMessage: message,
        botReply: reply,
        source: "lead_request"
      });

      return res.json({ reply });
    }

    /* 🔍 HANDLE CLARIFICATION RESPONSE */
    const pendingClarification = await Chat.findOne({ awaitingClarification: true }).sort({ createdAt: -1 });

    if (pendingClarification) {
      if (isClarificationAnswer(message)) {
        const reply = `You can view our available listings here:<br>
        <a href="${GENERAL_LISTINGS_URL}" target="_blank">${GENERAL_LISTINGS_URL}</a>`;

        await Chat.create({
          userMessage: message,
          botReply: reply,
          source: "listing_rule",
          awaitingClarification: false
        });

        return res.json({ reply });
      }

      await Chat.updateMany(
        { awaitingClarification: true },
        { awaitingClarification: false }
      );
    }

    /* ❓ ASK CLARIFICATION FOR AMBIGUOUS QUERIES */
    if (isAmbiguousQuery(message) && hasListingIntent(message)) {
      const reply =
        "Would you like to know about our available listings, or are you looking for general information?";

      await Chat.create({
        userMessage: message,
        botReply: reply,
        source: "clarification",
        awaitingClarification: true
      });

      return res.json({ reply });
    }

    /* 🔥 LISTING LINKS */
    const matchedListing = detectListingLink(message);
    if (matchedListing) {
      const reply = `You can view the relevant listings here:<br>
      <a href="${matchedListing}" target="_blank">${matchedListing}</a>`;

      await Chat.create({
        userMessage: message,
        botReply: reply,
        source: "listing_rule"
      });

      return res.json({ reply });
    }

    /* 🤖 AI FALLBACK */
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are the official AI assistant for Green Fields Real Estate.
Your name is Greenfield Intelligence Assistant.

PRIORITY RULES:
1. Use FAQ answers verbatim when matched
2. Use TXT training files
3. Use website content
4. If answer not found, say "Please contact our team"
5. Do not mention AI, ChatGPT, or OpenAI

${faqTraining}

=== TXT TRAINING ===
${txtTraining}

=== WEBSITE CONTENT ===
${websiteTraining}
`
        },
        { role: "user", content: message }
      ]
    });

    const reply = completion.choices[0].message.content;

    await Chat.create({
      userMessage: message,
      botReply: reply,
      source: "ai"
    });

    res.json({ reply });

  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chatbot error" });
  }
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Bot running on http://localhost:${PORT}`)
);
