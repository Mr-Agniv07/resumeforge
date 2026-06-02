const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const mongoose  = require("mongoose");
const jwt       = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
require("dotenv").config();

const app          = express();
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.set("trust proxy", 1);

// ── Security ──────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET","POST","PATCH"],
  allowedHeaders: ["Content-Type","Authorization","x-admin-key"]
}));
app.use(express.json());
app.use("/api/", rateLimit({ windowMs: 15*60*1000, max: 50,
  message: { error: "Too many requests. Please wait." } }));

// ── MongoDB ───────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ════════════════════════════════════════════════════════════
//  SCHEMAS
// ════════════════════════════════════════════════════════════
function nextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1); d.setHours(0,0,0,0);
  return d;
}

const userSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:         { type: String, default: "" },
  picture:      { type: String, default: "" },
  plan:         { type: String, enum: ["free","pro"], default: "free" },
  proSince:     { type: Date, default: null },
  proUntil:     { type: Date, default: null },
  cvCount:      { type: Number, default: 0 },
  countResetAt: { type: Date, default: () => nextMonthReset() },
  createdAt:    { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now },
});

const paymentSchema = new mongoose.Schema({
  email:       { type: String, required: true, lowercase: true, trim: true },
  name:        { type: String, default: "" },
  utr:         { type: String, required: true, trim: true },
  amount:      { type: Number, required: true },
  plan:        { type: String, enum: ["pro","single"], required: true },
  status:      { type: String, enum: ["pending","approved","rejected"], default: "pending" },
  adminNote:   { type: String, default: "" },
  submittedAt: { type: Date, default: Date.now },
  reviewedAt:  { type: Date, default: null },
});

const User    = mongoose.model("User",    userSchema);
const Payment = mongoose.model("Payment", paymentSchema);

// ── Helpers ───────────────────────────────────────────────────
function signJWT(user) {
  return jwt.sign(
    { userId: user._id.toString(), email: user.email, plan: user.plan },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Login required." });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden." });
  }
  next();
}

async function refreshUser(user) {
  // Auto-expire Pro plan
  if (user.plan === "pro" && user.proUntil && user.proUntil < new Date()) {
    user.plan = "free"; user.proUntil = null;
  }
  // Reset monthly counter
  if (new Date() > user.countResetAt) {
    user.cvCount = 0;
    user.countResetAt = nextMonthReset();
  }
  user.lastActiveAt = new Date();
  await user.save();
}

// ════════════════════════════════════════════════════════════
//  AUTH — Google Sign-In
// ════════════════════════════════════════════════════════════

// POST /api/auth/google
// Body: { credential } — the Google ID token from the frontend
app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: "Google credential missing." });

    // Verify the Google token
    const ticket = await googleClient.verifyIdToken({
      idToken:  credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, name, picture } = payload;

    // Find or create user
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({ email, name: name||"", picture: picture||"" });
      console.log(`✨ New user: ${email}`);
    } else {
      // Update name/picture in case they changed
      user.name    = name || user.name;
      user.picture = picture || user.picture;
    }

    await refreshUser(user);

    const token = signJWT(user);
    const FREE_LIMIT = parseInt(process.env.FREE_MONTHLY_LIMIT) || 2;

    return res.json({
      success: true,
      token,
      user: {
        email:     user.email,
        name:      user.name,
        picture:   user.picture,
        plan:      user.plan,
        isPro:     user.plan === "pro",
        cvCount:   user.cvCount,
        cvLimit:   user.plan === "pro" ? null : FREE_LIMIT,
        remaining: user.plan === "pro" ? null : Math.max(0, FREE_LIMIT - user.cvCount),
      },
    });
  } catch (err) {
    console.error("Google auth error:", err.message);
    res.status(401).json({ error: "Google authentication failed. Please try again." });
  }
});

// GET /api/auth/me — get current user info (called on page load)
app.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  await refreshUser(user);
  const FREE_LIMIT = parseInt(process.env.FREE_MONTHLY_LIMIT) || 2;

  res.json({
    email:     user.email,
    name:      user.name,
    picture:   user.picture,
    plan:      user.plan,
    isPro:     user.plan === "pro",
    cvCount:   user.cvCount,
    cvLimit:   user.plan === "pro" ? null : FREE_LIMIT,
    remaining: user.plan === "pro" ? null : Math.max(0, FREE_LIMIT - user.cvCount),
    proUntil:  user.proUntil,
  });
});

// ════════════════════════════════════════════════════════════
//  PAYMENT ROUTES
// ════════════════════════════════════════════════════════════

// POST /api/payment/submit — user submits UTR after paying via UPI
app.post("/api/payment/submit", async (req, res) => {
  const { email, name, utr, plan } = req.body;
  if (!email || !utr || !plan) {
    return res.status(400).json({ error: "Email, UTR, and plan are required." });
  }
  if (!["pro","single"].includes(plan)) {
    return res.status(400).json({ error: "Invalid plan." });
  }

  // Prevent duplicate UTR submissions
  const existing = await Payment.findOne({ utr });
  if (existing) {
    return res.status(409).json({ error: "This UTR has already been submitted." });
  }

  const amount = plan === "pro" ? 499 : 199;
  const payment = await Payment.create({ email, name, utr, amount, plan });

  // Ensure user record exists even if they haven't logged in yet
  const user = await User.findOne({ email });
  if (!user) await User.create({ email, name: name||"" });

  console.log(`💰 Payment submitted: ${email} | UTR: ${utr} | Plan: ${plan}`);

  res.json({
    success: true,
    message: "Payment submitted! We'll verify within few minutes and upgrade your account.",
    paymentId: payment._id,
  });
});

// ════════════════════════════════════════════════════════════
//  ADMIN ROUTES (protected by x-admin-key header)
// ════════════════════════════════════════════════════════════

// GET /api/admin/payments?status=pending
app.get("/api/admin/payments", requireAdmin, async (req, res) => {
  const { status = "pending" } = req.query;
  const payments = await Payment.find({ status }).sort({ submittedAt: -1 });
  res.json({ payments });
});

// GET /api/admin/users
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const users = await User.find({}).sort({ createdAt: -1 });
  res.json({ users });
});

// PATCH /api/admin/payments/:id/approve
app.patch("/api/admin/payments/:id/approve", requireAdmin, async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (payment.status !== "pending") return res.status(400).json({ error: "Already reviewed." });

  payment.status     = "approved";
  payment.adminNote  = req.body.adminNote || "";
  payment.reviewedAt = new Date();
  await payment.save();

  // Upgrade the user
  let user = await User.findOne({ email: payment.email });
  if (!user) user = await User.create({ email: payment.email, name: payment.name });

  user.plan     = "pro";
  user.proSince = new Date();
  // Pro monthly = 31 days, single CV = 7 days
  user.proUntil = new Date(Date.now() + (payment.plan === "pro" ? 31 : 7) * 24 * 60 * 60 * 1000);
  await user.save();

  console.log(`✅ Approved: ${payment.email} → Pro until ${user.proUntil}`);
  res.json({ success: true, message: `${payment.email} upgraded to Pro.` });
});

// PATCH /api/admin/payments/:id/reject
app.patch("/api/admin/payments/:id/reject", requireAdmin, async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found." });

  payment.status     = "rejected";
  payment.adminNote  = req.body.adminNote || "";
  payment.reviewedAt = new Date();
  await payment.save();

  res.json({ success: true, message: "Payment rejected." });
});

// PATCH /api/admin/users/:id/downgrade
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

  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  await refreshUser(user);

  const FREE_LIMIT = parseInt(process.env.FREE_MONTHLY_LIMIT) || 2;

  if (user.plan === "free" && user.cvCount >= FREE_LIMIT) {
    return res.status(429).json({
      error: `Free limit reached (${FREE_LIMIT} CVs/month). Upgrade to Pro for unlimited!`,
      upgradeUrl: "#pricing",
    });
  }

  const prompt = `You are an expert resume writer. Create a complete professional resume for someone targeting "${role}"${company ? ` at ${company}` : ""}.

Candidate: ${name||"Candidate"} | ${email||""} | ${phone||""} | ${location||""}
Experience: ${experience}

Return ONLY raw JSON (no markdown, no backticks, no explanation):
{
  "name": "${name||"Candidate"}",
  "title": "Professional title matching the target role",
  "email": "${email||"email@example.com"}",
  "phone": "${phone||"+91 98765 43210"}",
  "location": "${location||"Hyderabad, India"}",
  "linkedin": "linkedin.com/in/firstname-lastname",
  "portfolio": "",
  "summary": "3 sentences: years+skill, key achievement, value for this role",
  "experience": [
    {
      "company": "Company Name",
      "role": "Job Title",
      "duration": "Jan 2022 – Present",
      "location": "City, Country",
      "bullets": [
        "Strong action verb + what you did + quantified result",
        "Strong action verb + what you did + quantified result",
        "Strong action verb + what you did + quantified result"
      ]
    }
  ],
  "education": [
    { "degree": "B.Tech Computer Science", "institution": "University Name", "year": "2019", "gpa": "8.5/10" }
  ],
  "skills": {
    "technical": ["Skill1","Skill2","Skill3","Skill4","Skill5","Skill6","Skill7","Skill8"],
    "soft": ["Leadership","Communication","Problem Solving","Team Collaboration"]
  },
  "certifications": [
    { "name": "Certification Name", "issuer": "Issuing Body", "year": "2023" }
  ],
  "projects": [
    { "name": "Project Name", "description": "What it does + tech stack + impact/scale", "tech": ["Tech1","Tech2","Tech3"] }
  ],
  "languages": ["English (Fluent)", "Hindi (Native)"],
  "coverLetter": "Full 3-paragraph cover letter. Para1: enthusiasm for role and company. Para2: 2-3 specific achievements matching the role. Para3: confident call to action."
}

Rules: infer all details from experience. Make bullets punchy and quantified. Use strong action verbs.`;

  let text;
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }],
    });

    text = message.content.map(b => b.text || "").join("").trim();
    text = text.replace(/```json|```/g, "").trim();
    const resume = JSON.parse(text);

    user.cvCount++;
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
    console.error("AI error:", err.message, "\nRaw:", text);
    return res.status(502).json({ error: "AI generation failed. Please try again." });
  }
});

// POST /api/linkedin (Pro only)
app.post("/api/linkedin", requireAuth, async (req, res) => {
  const { experience, role } = req.body;
  if (!experience || !role) return res.status(400).json({ error: "experience and role are required." });

  const user = await User.findById(req.user.userId);
  if (!user || user.plan !== "pro") {
    return res.status(403).json({ error: "LinkedIn rewrite is a Pro feature.", upgradeUrl: "#pricing" });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 600,
      messages: [{ role: "user", content: `Rewrite this LinkedIn About section for the role of ${role}. 3 short paragraphs, first-person, no buzzwords, end with CTA.\n\nBackground: ${experience}` }],
    });
    res.json({ success: true, output: message.content.map(b => b.text||"").join("") });
  } catch {
    res.status(502).json({ error: "Generation failed." });
  }
});

// Health check
app.get("/api/health", (_, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ ResumeForge backend running on port ${PORT}`));
