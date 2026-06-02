// ============================================================
//  ResumeForge Backend — Node.js + Express
//  Your API key stays HERE on the server. Never sent to browser.
// ============================================================

const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const Anthropic  = require("@anthropic-ai/sdk");
require("dotenv").config();

const app = express();

// ── Security headers ─────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}));

// ── CORS — only allow your own frontend domain ───────────────
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// ── Anthropic client (API key stays on server) ───────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory usage tracker (swap for DB later) ──────────────
const usageMap = new Map(); // ip → { count, resetAt }

function checkFreeLimit(ip) {
  const now     = Date.now();
  const entry   = usageMap.get(ip);
  const FREE_LIMIT = parseInt(process.env.FREE_MONTHLY_LIMIT) || 2;

  if (!entry || now > entry.resetAt) {
    usageMap.set(ip, { count: 1, resetAt: now + 30 * 24 * 60 * 60 * 1000 });
    return { allowed: true, remaining: FREE_LIMIT - 1 };
  }
  if (entry.count >= FREE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  entry.count++;
  return { allowed: true, remaining: FREE_LIMIT - entry.count };
}

// ── Rate limiter — 20 requests / 15 min per IP ───────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many requests. Please wait a few minutes." },
});
app.use("/api/", limiter);

// ════════════════════════════════════════════════════════════
//  POST /api/generate
//  Body: { experience, role, company }
// ════════════════════════════════════════════════════════════
app.post("/api/generate", async (req, res) => {
  const { experience, role, company, isPro } = req.body;
  const ip = req.ip;

  // ── Validate input ───────────────────────────────────────
  if (!experience || !role) {
    return res.status(400).json({ error: "experience and role are required." });
  }
  if (experience.length > 4000) {
    return res.status(400).json({ error: "Experience text is too long (max 4000 chars)." });
  }

  // ── Free-tier limit (skip if pro token present) ──────────
  // In production: verify isPro via Razorpay subscription check or JWT
  if (!isPro) {
    const { allowed, remaining } = checkFreeLimit(ip);
    if (!allowed) {
      return res.status(429).json({
        error: "Free limit reached (2/month). Upgrade to Pro for unlimited resumes.",
        upgradeUrl: "/pricing",
      });
    }
    res.setHeader("X-Free-Remaining", remaining);
  }

  // ── Build prompt ─────────────────────────────────────────
  const { name, email, phone, location } = req.body;
  const prompt = `You are an expert resume writer. Create a complete professional resume for "${role}"${company ? ` at ${company}` : ""}.
Name: ${name||"Candidate"} | Email: ${email||""} | Phone: ${phone||""} | Location: ${location||""}
Experience: ${experience}

Return ONLY raw JSON, no markdown, no backticks:
{"name":"${name||"Candidate"}","title":"Professional title","email":"${email||""}","phone":"${phone||""}","location":"${location||""}","linkedin":"linkedin.com/in/profile","portfolio":"","summary":"3-sentence summary","experience":[{"company":"Company","role":"Title","duration":"Jan 2022 – Present","location":"City","bullets":["Action verb + result","Action verb + result","Action verb + result"]}],"education":[{"degree":"Degree","institution":"University","year":"2019","gpa":"8.5/10"}],"skills":{"technical":["Skill1","Skill2","Skill3","Skill4","Skill5","Skill6"],"soft":["Leadership","Communication"]},"certifications":[{"name":"Cert","issuer":"Issuer","year":"2023"}],"projects":[{"name":"Project","description":"What it does + impact","tech":["Tech1","Tech2"]}],"languages":["English (Fluent)","Hindi (Native)"],"coverLetter":"3 paragraph cover letter"}`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }],
    });

    let text = message.content.map(b => b.text || "").join("");
    text = text.replace(/```json|```/g, "").trim();
    const resume = JSON.parse(text);

    return res.json({ success: true, resume });
  } catch (err) {
    console.error("Full error:", err.message);
    console.error("Raw AI response:", text);
    return res.status(502).json({ error: "AI generation failed. Please try again." });
  }
});

// ════════════════════════════════════════════════════════════
//  POST /api/linkedin
//  Rewrites a LinkedIn summary (Pro feature)
// ════════════════════════════════════════════════════════════
app.post("/api/linkedin", async (req, res) => {
  const { experience, role } = req.body;
  if (!experience || !role) {
    return res.status(400).json({ error: "experience and role are required." });
  }

  const prompt = `Rewrite this person's LinkedIn About section to attract recruiters for the role of ${role}.
Make it 3 short paragraphs. First-person voice. No buzzwords. End with a clear CTA.

Background: ${experience}`;

  try {
    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 600,
      messages:   [{ role: "user", content: prompt }],
    });
    const text = message.content.map(b => b.text || "").join("");
    return res.json({ success: true, output: text });
  } catch (err) {
    return res.status(502).json({ error: "Generation failed." });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get("/api/health", (_, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ ResumeForge backend running on port ${PORT}`);
});
