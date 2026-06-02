// ============================================================
//  ResumeForge Backend — Node.js + Express
//  Auth: JWT · DB: MongoDB Atlas · Payments: Manual UPI
// ============================================================

const express   = require("express");
const { Resend } = require("resend");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const mongoose  = require("mongoose");
const jwt       = require("jsonwebtoken");
const crypto    = require("crypto");
require("dotenv").config();

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

app.set("trust proxy", 1);


// ── Security ─────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors({ origin: "*", methods: ["GET","POST","PATCH"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(express.json());

// ── Clients ──────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── MongoDB ──────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("MongoDB error:", err));

// ════════════════════════════════════════════════════════════
//  SCHEMAS
// ════════════════════════════════════════════════════════════

// User — every person who uses the app
const userSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:         { type: String, default: "" },

  // Plan: "free" | "pro"
  plan:         { type: String, enum: ["free","pro"], default: "free" },
  proSince:     { type: Date, default: null },
  proUntil:     { type: Date, default: null },   // null = no expiry (lifetime) or managed manually

  // Free-tier usage counter (resets monthly)
  cvCount:      { type: Number, default: 0 },
  countResetAt: { type: Date, default: () => nextMonthReset() },

  // Magic-link token for passwordless login
  loginToken:   { type: String, default: null },
  loginTokenExp:{ type: Date,   default: null },

  createdAt:    { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now },
});

// Payment verification request
const paymentSchema = new mongoose.Schema({
  email:     { type: String, required: true, lowercase: true, trim: true },
  name:      { type: String, default: "" },
  utr:       { type: String, required: true, trim: true },  // UTR / transaction ID
  amount:    { type: Number, required: true },
  plan:      { type: String, enum: ["pro","single"], required: true },

  // "pending" → admin reviews → "approved" | "rejected"
  status:    { type: String, enum: ["pending","approved","rejected"], default: "pending" },
  adminNote: { type: String, default: "" },

  submittedAt: { type: Date, default: Date.now },
  reviewedAt:  { type: Date, default: null },
});

const User    = mongoose.model("User",    userSchema);
const Payment = mongoose.model("Payment", paymentSchema);

// ── Helpers ───────────────────────────────────────────────────
function nextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1); d.setHours(0,0,0,0);
  return d;
}

function signJWT(user) {
  return jwt.sign(
    { userId: user._id.toString(), email: user.email, plan: user.plan },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

// ── Auth middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Login required." });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
}

// Admin middleware — simple secret header
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden." });
  }
  next();
}

// ── Email (Nodemailer via Gmail SMTP) ─────────────────────────
async function sendMagicLink(email, token) {
  const link = `${process.env.FRONTEND_URL}/login?token=${token}`;

  const result = await resend.emails.send({
    from: "onboarding@resend.dev",
    to: email,
    subject: "Your ResumeForge Login Link",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Sign in to ResumeForge</h2>
        <p>Click below to login. Link expires in 15 minutes.</p>

        <a href="${link}"
           style="display:inline-block;padding:12px 24px;background:#c9a84c;color:black;text-decoration:none;border-radius:8px;">
          Log In
        </a>
      </div>
    `
  });

  console.log("Resend result:", result);
}

async function sendProConfirmation(email, name, plan) {
  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: email,
    subject: "You're now a ResumeForge Pro member 🎉",
    html: `
      <h2>Welcome to Pro, ${name || "friend"}!</h2>
      <p>Your payment has been verified.</p>
      <p>Plan: ${plan}</p>
    `
  });
}

// ── Rate limiter ──────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15*60*1000, max: 30,
  message: { error: "Too many requests. Please wait a few minutes." } });
app.use("/api/", limiter);


// ════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════

// POST /api/auth/magic  — request a magic login link
app.post("/api/auth/magic", async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: "Email required." });

  let user = await User.findOne({ email });
  if (!user) user = await User.create({ email, name: name||"" });

  const token = crypto.randomBytes(32).toString("hex");
  user.loginToken    = token;
  user.loginTokenExp = new Date(Date.now() + 15 * 60 * 1000); // 15 min
  await user.save();

  try {
    await sendMagicLink(email, token);
    res.json({ success: true, message: "Magic link sent! Check your email." });
  } catch (err) {
    console.error("Mail error:", err.message);
    res.status(500).json({ error: "Failed to send email. Try again." });
  }
});

// GET /api/auth/verify?token=xxx  — exchange magic token for JWT
app.get("/api/auth/verify", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Token missing." });

  const user = await User.findOne({ loginToken: token });
  if (!user || !user.loginTokenExp || user.loginTokenExp < new Date()) {
    return res.status(400).json({ error: "Link expired or invalid. Please request a new one." });
  }

  // Clear magic token
  user.loginToken    = null;
  user.loginTokenExp = null;
  user.lastActiveAt  = new Date();
  await user.save();

  const jwtToken = signJWT(user);
  res.json({
    success: true,
    token: jwtToken,
    user: { email: user.email, name: user.name, plan: user.plan, cvCount: user.cvCount },
  });
});

// GET /api/auth/me  — get current user info
app.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.userId).select("-loginToken -loginTokenExp");
  if (!user) return res.status(404).json({ error: "User not found." });

  // Reset monthly count if needed
  if (new Date() > user.countResetAt) {
    user.cvCount     = 0;
    user.countResetAt = nextMonthReset();
    await user.save();
  }

  const FREE_LIMIT = parseInt(process.env.FREE_MONTHLY_LIMIT) || 2;
  res.json({
    email:     user.email,
    name:      user.name,
    plan:      user.plan,
    isPro:     user.plan === "pro",
    cvCount:   user.cvCount,
    cvLimit:   user.plan === "pro" ? null : FREE_LIMIT,   // null = unlimited
    remaining: user.plan === "pro" ? null : Math.max(0, FREE_LIMIT - user.cvCount),
    proUntil:  user.proUntil,
  });
});


// ════════════════════════════════════════════════════════════
//  PAYMENT ROUTES
// ════════════════════════════════════════════════════════════

// POST /api/payment/submit  — user submits UTR after paying
app.post("/api/payment/submit", async (req, res) => {
  const { email, name, utr, plan } = req.body;

  if (!email || !utr || !plan) {
    return res.status(400).json({ error: "email, utr, and plan are required." });
  }
  if (!["pro","single"].includes(plan)) {
    return res.status(400).json({ error: "Invalid plan." });
  }

  // Check if this UTR was already submitted
  const existing = await Payment.findOne({ utr });
  if (existing) {
    return res.status(409).json({ error: "This UTR has already been submitted." });
  }

  const amount = plan === "pro" ? 499 : 199;
  const payment = await Payment.create({ email, name, utr, amount, plan });

  // Ensure user exists
  let user = await User.findOne({ email });
  if (!user) await User.create({ email, name: name||"" });

  res.json({
    success: true,
    message: "Payment submitted! We'll verify within a few hours and email you.",
    paymentId: payment._id,
  });
});


// ════════════════════════════════════════════════════════════
//  ADMIN ROUTES  (protected by x-admin-key header)
// ════════════════════════════════════════════════════════════

// GET /api/admin/payments  — list all pending payments
app.get("/api/admin/payments", requireAdmin, async (req, res) => {
  const { status = "pending" } = req.query;
  const payments = await Payment.find({ status }).sort({ submittedAt: -1 });
  res.json({ payments });
});

// GET /api/admin/users  — list all users
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const users = await User.find({}).sort({ createdAt: -1 }).select("-loginToken -loginTokenExp");
  res.json({ users });
});

// PATCH /api/admin/payments/:id/approve  — approve a payment
app.patch("/api/admin/payments/:id/approve", requireAdmin, async (req, res) => {
  const { adminNote = "" } = req.body;
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (payment.status !== "pending") {
    return res.status(400).json({ error: "Payment already reviewed." });
  }

  // Update payment record
  payment.status     = "approved";
  payment.adminNote  = adminNote;
  payment.reviewedAt = new Date();
  await payment.save();

  // Upgrade the user
  let user = await User.findOne({ email: payment.email });
  if (!user) user = await User.create({ email: payment.email, name: payment.name });

  user.plan     = "pro";
  user.proSince = new Date();
  if (payment.plan === "pro") {
    // Pro monthly — give 31 days
    user.proUntil = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
  } else {
    // Single CV — give 7 days access, cvCount boost
    user.proUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }
  await user.save();

  // Send confirmation email
  try { await sendProConfirmation(payment.email, payment.name, payment.plan); }
  catch(e) { console.error("Confirmation mail failed:", e.message); }

  res.json({ success: true, message: `User ${payment.email} upgraded to Pro.` });
});

// PATCH /api/admin/payments/:id/reject  — reject a payment
app.patch("/api/admin/payments/:id/reject", requireAdmin, async (req, res) => {
  const { adminNote = "" } = req.body;
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found." });

  payment.status     = "rejected";
  payment.adminNote  = adminNote;
  payment.reviewedAt = new Date();
  await payment.save();

  res.json({ success: true, message: "Payment rejected." });
});

// PATCH /api/admin/users/:id/downgrade  — manually downgrade a user
app.patch("/api/admin/users/:id/downgrade", requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  user.plan = "free"; user.proUntil = null; user.proSince = null;
  await user.save();
  res.json({ success: true });
});


// ════════════════════════════════════════════════════════════
//  CORE — POST /api/generate
// ════════════════════════════════════════════════════════════
app.post("/api/generate", requireAuth, async (req, res) => {
  const { experience, role, company, name, email, phone, location } = req.body;

  if (!experience || !role) return res.status(400).json({ error: "experience and role are required." });
  if (experience.length > 4000) return res.status(400).json({ error: "Experience text too long (max 4000 chars)." });

  // Load fresh user from DB — NEVER trust plan from JWT alone
  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  // Auto-expire Pro if date passed
  if (user.plan === "pro" && user.proUntil && user.proUntil < new Date()) {
    user.plan = "free"; user.proUntil = null;
    await user.save();
  }

  // Reset monthly counter if new month
  if (new Date() > user.countResetAt) {
    user.cvCount     = 0;
    user.countResetAt = nextMonthReset();
    await user.save();
  }

  const FREE_LIMIT = parseInt(process.env.FREE_MONTHLY_LIMIT) || 2;

  // Free-tier gate
  if (user.plan === "free" && user.cvCount >= FREE_LIMIT) {
    return res.status(429).json({
      error: `Free limit reached (${FREE_LIMIT} CVs/month). Upgrade to Pro for unlimited.`,
      upgradeUrl: "/pricing",
    });
  }

  // Build prompt
  const prompt = `You are an expert resume writer. Create a complete professional resume for "${role}"${company ? ` at ${company}` : ""}.
Name: ${name||"Candidate"} | Email: ${email||""} | Phone: ${phone||""} | Location: ${location||""}
Experience: ${experience}

Return ONLY raw JSON, no markdown, no backticks:
{"name":"${name||"Candidate"}","title":"Professional title","email":"${email||""}","phone":"${phone||""}","location":"${location||""}","linkedin":"linkedin.com/in/profile","portfolio":"","summary":"3-sentence summary","experience":[{"company":"Company","role":"Title","duration":"Jan 2022 – Present","location":"City","bullets":["Action verb + result","Action verb + result","Action verb + result"]}],"education":[{"degree":"Degree","institution":"University","year":"2019","gpa":"8.5/10"}],"skills":{"technical":["Skill1","Skill2","Skill3","Skill4","Skill5","Skill6"],"soft":["Leadership","Communication"]},"certifications":[{"name":"Cert","issuer":"Issuer","year":"2023"}],"projects":[{"name":"Project","description":"What it does + impact","tech":["Tech1","Tech2"]}],"languages":["English (Fluent)","Hindi (Native)"],"coverLetter":"3 paragraph cover letter"}`;

  let text;
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }],
    });

    text = message.content.map(b => b.text || "").join("");
    text = text.replace(/```json|```/g, "").trim();
    const resume = JSON.parse(text);

    // Increment usage counter
    user.cvCount++;
    user.lastActiveAt = new Date();
    await user.save();

    return res.json({
      success: true,
      resume,
      usage: {
        plan:      user.plan,
        cvCount:   user.cvCount,
        remaining: user.plan === "pro" ? null : Math.max(0, FREE_LIMIT - user.cvCount),
      },
    });
  } catch (err) {
    console.error("AI error:", err.message, "Raw:", text);
    return res.status(502).json({ error: "AI generation failed. Please try again." });
  }
});


// ════════════════════════════════════════════════════════════
//  POST /api/linkedin  (Pro only)
// ════════════════════════════════════════════════════════════
app.post("/api/linkedin", requireAuth, async (req, res) => {
  const { experience, role } = req.body;
  if (!experience || !role) return res.status(400).json({ error: "experience and role are required." });

  const user = await User.findById(req.user.userId);
  if (!user || user.plan !== "pro") {
    return res.status(403).json({ error: "LinkedIn rewrite is a Pro feature. Upgrade to access it.", upgradeUrl: "/pricing" });
  }

  const prompt = `Rewrite this person's LinkedIn About section to attract recruiters for the role of ${role}.
Make it 3 short paragraphs. First-person voice. No buzzwords. End with a clear CTA.
Background: ${experience}`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = message.content.map(b => b.text || "").join("");
    res.json({ success: true, output: text });
  } catch {
    res.status(502).json({ error: "Generation failed." });
  }
});


// ── Health ────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ ResumeForge backend on port ${PORT}`));
