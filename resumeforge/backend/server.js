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
  proUntil:     { type: Date, default: null },   // null + plan "pro" = lifetime (never expires)
  credits:      { type: Number, default: 0 },     // paid one-off generations (single / packs)
  signedIn:     { type: Boolean, default: false },// true once they authenticate via Google
  premiumTemplates: { type: Boolean, default: false }, // unlocked by pack10 / pro (not single)
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
  plan:        { type: String, enum: ["pro","single","pack10"], required: true },
  anonymous:   { type: Boolean, default: false }, // purchased without signing in
  status:      { type: String, enum: ["pending","approved","rejected"], default: "pending" },
  adminNote:   { type: String, default: "" },
  submittedAt: { type: Date, default: Date.now },
  reviewedAt:  { type: Date, default: null },
});

const User    = mongoose.model("User",    userSchema);
const Payment = mongoose.model("Payment", paymentSchema);

// ── Plan catalogue ────────────────────────────────────────────
// amount = price in ₹ · credits = generations granted · lifetime = unlimited Pro
const PLANS = {
  single: { amount: 15,  credits: 1,  lifetime: false, templates: false, label: "Single CV"     },
  pack10: { amount: 59,  credits: 10, lifetime: false, templates: true,  label: "10 CV Pack"     },
  pro:    { amount: 499, credits: 0,  lifetime: true,  templates: true,  label: "Pro (Lifetime)" },
};

// ── Profession-specific resume tailoring ──────────────────────
// `field` from the frontend selects how Claude specializes the resume.
const PROFESSIONS = {
  engineering: {
    label: "Engineering / Technology",
    guidance: "Tailor for a software/IT/engineering role. Lead with a strong technical skills list (languages, frameworks, cloud, tools). Quantify engineering impact (latency, scale, uptime, cost). Highlight system/architecture ownership and projects with explicit tech stacks. Surface certs like AWS/GCP/Azure/PMP. Use precise verbs: architected, optimized, automated, deployed.",
    sections: ["Open-Source & Side Projects", "Technical Achievements"],
  },
  medical: {
    label: "Medical / Healthcare",
    guidance: "Tailor for a clinical/medical role. Emphasize clinical experience, specialty, patient outcomes, procedures performed, and hospital/clinic affiliations. Put medical degrees (MBBS, MD, DNB), council registration/license, residencies, fellowships, and research/publications prominently in certifications/education. The technical skills must be CLINICAL competencies (e.g., diagnostics, procedures, EMR), never generic IT skills.",
    sections: ["Licenses & Registrations", "Publications & Research", "Clinical Procedures"],
  },
  legal: {
    label: "Legal / Law",
    guidance: "Tailor for a legal/law role. Emphasize practice areas (litigation, corporate, IP, criminal), bar council enrollment, jurisdictions, drafting, legal research, advocacy, and negotiations. Reference notable matters at a high level without breaching confidentiality. Degrees: LLB/LLM. The technical skills must be LEGAL competencies.",
    sections: ["Bar Admissions & Enrollment", "Notable Matters", "Practice Areas"],
  },
  teaching: {
    label: "Teaching / Education",
    guidance: "Tailor for a teaching/education role. Emphasize subjects and grade levels taught, pedagogy, classroom management, curriculum design, and measurable student outcomes. Surface B.Ed/M.Ed and teaching certifications (TET/CTET/NET). The technical skills must be TEACHING competencies.",
    sections: ["Publications & Workshops", "Awards & Achievements"],
  },
  finance: {
    label: "Finance / Accounting",
    guidance: "Tailor for a finance/accounting role. Emphasize financial analysis, reporting, auditing, budgeting, taxation, and compliance. Tools: Excel, SAP, Tally, ERP. Certs: CA, CFA, CPA, ACCA. Quantify results (cost savings, revenue, accuracy). The technical skills must be FINANCE competencies.",
    sections: ["Licenses & Memberships", "Key Achievements"],
  },
  business: {
    label: "Business / Management",
    guidance: "Tailor for a business/management role. Emphasize leadership, P&L ownership, strategy, operations, stakeholder management, team size led, and quantified business outcomes (growth %, revenue, efficiency). Surface MBA/management credentials.",
    sections: ["Key Achievements", "Leadership Highlights"],
  },
  design: {
    label: "Design / Creative",
    guidance: "Tailor for a design/creative role. Use a portfolio-oriented narrative. Emphasize design tools (Figma, Adobe CC), UX/UI process, brand/visual work, and measurable impact (engagement, conversion). The technical skills must be design tools and methods.",
    sections: ["Portfolio Highlights", "Awards & Recognition"],
  },
  sales: {
    label: "Sales / Marketing",
    guidance: "Tailor for a sales/marketing role. Lead with quota attainment, revenue/pipeline generated, growth metrics, campaigns, CRM tools, and client relationships. Every bullet should be commercially quantified.",
    sections: ["Key Accounts & Wins", "Awards & Recognition"],
  },
  general: {
    label: "General / Other",
    guidance: "Write a strong, well-rounded professional resume tailored closely to the target role.",
    sections: ["Key Achievements"],
  },
};

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
  // Auto-expire time-limited Pro plans (lifetime Pro keeps proUntil = null and never expires)
  if (user.plan === "pro" && user.proUntil && user.proUntil < new Date()) {
    user.plan = "free"; user.proUntil = null;
  }
  // Reset monthly free counter
  if (new Date() > user.countResetAt) {
    user.cvCount = 0;
    user.countResetAt = nextMonthReset();
  }
  user.lastActiveAt = new Date();
  await user.save();
}

const FREE_LIMIT = () => parseInt(process.env.FREE_MONTHLY_LIMIT) || 2;

// Free monthly allowance only applies to signed-in (Google) users.
function freeRemaining(user) {
  if (!user.signedIn) return 0;
  return Math.max(0, FREE_LIMIT() - user.cvCount);
}

// Shape returned to the frontend for any user.
function userPayload(user) {
  const isPro = user.plan === "pro";
  return {
    email:     user.email,
    name:      user.name,
    picture:   user.picture,
    plan:      user.plan,
    isPro,
    credits:   user.credits,
    signedIn:  user.signedIn,
    templates: isPro || user.premiumTemplates,   // eligible for premium templates
    cvCount:   user.cvCount,
    cvLimit:   isPro ? null : (user.signedIn ? FREE_LIMIT() : 0),
    remaining: isPro ? null : freeRemaining(user) + user.credits,
    proUntil:  user.proUntil,
  };
}

// Reads a JWT if present but never blocks the request (used for anonymous-aware routes).
function readAuth(req) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); }
  catch { return null; }
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
      user = await User.create({ email, name: name||"", picture: picture||"", signedIn: true });
      console.log(`✨ New user: ${email}`);
    } else {
      // Update name/picture in case they changed; mark as signed-in
      user.name     = name || user.name;
      user.picture  = picture || user.picture;
      user.signedIn = true;
    }

    await refreshUser(user);

    const token = signJWT(user);
    return res.json({ success: true, token, user: userPayload(user) });
  } catch (err) {
    console.error("Google auth error:", err.message);
    res.status(401).json({ error: "Google authentication failed. Please try again." });
  }
});

// POST /api/auth/claim — anonymous purchaser unlocks a session via email + UTR
// Body: { email, utr } — must match an APPROVED payment. Returns a JWT so they can generate.
app.post("/api/auth/claim", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const utr   = (req.body.utr || "").trim();
  if (!email || !utr) return res.status(400).json({ error: "Email and UTR are required." });

  const payment = await Payment.findOne({ email, utr });
  if (!payment)                       return res.status(404).json({ error: "No payment found for that email and UTR." });
  if (payment.status === "rejected")  return res.status(403).json({ error: "This payment was rejected." });
  if (payment.status !== "approved")  return res.status(409).json({ error: "Payment not verified yet. Please wait a few minutes and try again." });

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: "Account not found." });

  await refreshUser(user);
  const token = signJWT(user);
  res.json({ success: true, token, user: userPayload(user) });
});

// GET /api/auth/me — get current user info (called on page load)
app.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  await refreshUser(user);
  res.json(userPayload(user));
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
  if (!PLANS[plan]) {
    return res.status(400).json({ error: "Invalid plan." });
  }

  // Prevent duplicate UTR submissions
  const existing = await Payment.findOne({ utr });
  if (existing) {
    return res.status(409).json({ error: "This UTR has already been submitted." });
  }

  // A valid JWT means the buyer is signed in; otherwise the purchase is anonymous.
  const anonymous = !readAuth(req);
  const amount    = PLANS[plan].amount;
  const payment   = await Payment.create({ email, name, utr, amount, plan, anonymous });

  // Ensure user record exists even if they haven't logged in yet
  const user = await User.findOne({ email });
  if (!user) await User.create({ email, name: name||"" });

  console.log(`💰 Payment submitted: ${email} | UTR: ${utr} | Plan: ${plan}${anonymous ? " (anon)" : ""}`);

  res.json({
    success: true,
    message: "Payment submitted! We'll verify within few minutes and unlock your account.",
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

  // Upgrade / credit the user
  let user = await User.findOne({ email: payment.email });
  if (!user) user = await User.create({ email: payment.email, name: payment.name });

  const cfg = PLANS[payment.plan] || PLANS.single;
  let summary;
  if (cfg.lifetime) {
    user.plan     = "pro";
    user.proSince = new Date();
    user.proUntil = null;                 // lifetime — never expires
    summary = `${payment.email} upgraded to Pro (lifetime).`;
  } else {
    user.credits += cfg.credits;          // single / packs add generation credits
    summary = `${payment.email} credited +${cfg.credits} (total ${user.credits}).`;
  }
  if (cfg.templates) user.premiumTemplates = true;  // pack10 / pro unlock template choices
  await user.save();

  console.log(`✅ Approved: ${summary}`);
  res.json({ success: true, message: summary });
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
  const { experience, role, company, name, email, phone, location, linkedin, portfolio, field } = req.body;
  const prof = PROFESSIONS[field] || PROFESSIONS.general;

  if (!experience || !role) return res.status(400).json({ error: "experience and role are required." });
  if (experience.length > 4000) return res.status(400).json({ error: "Experience text too long (max 4000 chars)." });

  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  await refreshUser(user);

  // Decide which allowance pays for this generation:
  //   Pro      → unlimited
  //   Free     → monthly allowance (signed-in users only), preserved before paid credits
  //   Credits  → paid single / pack generations
  const isPro     = user.plan === "pro";
  const useFree   = !isPro && freeRemaining(user) > 0;
  const useCredit = !isPro && !useFree && user.credits > 0;

  if (!isPro && !useFree && !useCredit) {
    return res.status(402).json({
      error: user.signedIn
        ? `You've used your ${FREE_LIMIT()} free CVs this month and have no credits left. Buy a pack or go Pro for unlimited!`
        : "No credits left. Buy a single CV, a pack, or go Pro for unlimited!",
      upgradeUrl: "#pricing",
    });
  }

  const prompt = `You are an expert resume writer specializing in the ${prof.label} field. Create a complete professional resume for someone targeting "${role}"${company ? ` at ${company}` : ""}.

FIELD FOCUS — ${prof.label}: ${prof.guidance}

Candidate: ${name||"Candidate"} | ${email||""} | ${phone||""} | ${location||""}
Experience: ${experience}

Return ONLY raw JSON (no markdown, no backticks, no explanation):
{
  "name": "${name||"Candidate"}",
  "title": "Professional title matching the target role",
  "email": "${email||""}",
  "phone": "${phone||""}",
  "location": "${location||""}",
  "linkedin": "${linkedin||""}",
  "portfolio": "${portfolio||""}",
  "summary": "2 sentences MAX. Who they are professionally (field + years of experience + top strength). Do NOT list projects, achievements, or specific work here — those belong in Experience.",
  "experience": [
    {
      "company": "exact employer the candidate stated",
      "role": "exact job title the candidate stated",
      "duration": "exact dates if stated, else \"\"",
      "location": "location if stated, else \"\"",
      "bullets": [
        "strong action verb + real thing they did + quantified result (only real details)",
        "strong action verb + real thing they did + quantified result (only real details)"
      ]
    }
  ],
  "education": [
    { "degree": "exact degree the candidate stated", "institution": "exact institution", "year": "year if stated else \"\"", "gpa": "gpa only if stated else \"\"" }
  ],
  "skills": {
    "technical": ["skills the candidate stated or clearly implied by their work"],
    "soft": ["relevant soft skills"]
  },
  "certifications": [
    { "name": "certification the candidate actually mentioned", "issuer": "issuer if stated else \"\"", "year": "year if stated else \"\"" }
  ],
  "projects": [
    { "name": "project the candidate actually mentioned", "description": "what it does + impact", "tech": ["tech actually used"] }
  ],
  "languages": ["only languages the candidate actually mentioned"],
  "coverLetter": "Full 3-paragraph cover letter. Para1: enthusiasm for role and company. Para2: 2-3 specific achievements matching the role. Para3: confident call to action.",
  "extraSections": [
    { "heading": "Field-specific section title", "items": ["concise, specific point", "concise, specific point"] }
  ]
}

CRITICAL — DO NOT FABRICATE. The empty/example values in the JSON above are FORMAT ONLY. Build the resume strictly from the candidate's text:
- NEVER invent employers, job titles, dates/durations, locations, schools, degrees, GPAs, certifications, registration numbers, projects, or languages. Include an item ONLY if the candidate actually mentioned it.
- If the candidate did not mention education, certifications, projects, or languages, return an EMPTY array [] for that field.
- For any field you have no real value for, use "" — never guess.
- You MAY rephrase/strengthen real items, write the summary and cover letter, and list skills clearly implied by the work. You may NOT add facts the candidate did not provide.

Rules:
- ONE PAGE TARGET: The entire resume must fit on one A4 page. Be concise everywhere.
- Bullets: 2 per role — the 2 strongest, most quantified achievements. One line each. Lead with a strong action verb. Never pad to fill space.
- Summary: 2 sentences max. Sharp and specific — who they are, not what they did.
- Don't pad — quality over quantity in every section.
- CONTACT INFO IS NOT INVENTED. Use name/email/phone/location/linkedin/portfolio EXACTLY as given; empty stays "".
- "extraSections": include a section ONLY if it genuinely adds value from the candidate's text (suggested for ${prof.label}: ${prof.sections.length ? prof.sections.join(", ") : "none"}). If nothing qualifies, return "extraSections": [].`;

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

    // Contact details are authoritative from the user — overwrite anything the
    // model may have echoed/invented. Blank stays blank (the UI hides empties).
    resume.name      = (name || resume.name || "Candidate").trim();
    resume.email     = (email    || "").trim();
    resume.phone     = (phone    || "").trim();
    resume.location  = (location || "").trim();
    resume.linkedin  = (linkedin || "").trim();
    resume.portfolio = (portfolio|| "").trim();

    // Charge the allowance chosen above. cvCount always increments for analytics.
    user.cvCount++;
    if (useCredit) user.credits = Math.max(0, user.credits - 1);
    await user.save();

    return res.json({
      success: true,
      resume,
      usage: {
        plan:      user.plan,
        cvCount:   user.cvCount,
        credits:   user.credits,
        remaining: isPro ? null : freeRemaining(user) + user.credits,
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
