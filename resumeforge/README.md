# ResumeForge — Full Stack Setup & Deployment Guide

## Project Structure
```
resumeforge/
├── backend/
│   ├── server.js          ← Express API server (your API key lives here)
│   ├── package.json
│   ├── .env.example       ← Copy to .env and fill in your values
│   └── .gitignore
└── frontend/
    └── index.html         ← The website (calls your backend, no key exposed)
```

---

## Step 1 — Install Node.js
Download from https://nodejs.org (choose LTS version)
Verify: open terminal and run `node -v`

---

## Step 2 — Set up the backend

```bash
cd resumeforge/backend
npm install
cp .env.example .env
```

Now open `.env` in any text editor and fill in:
```
ANTHROPIC_API_KEY=sk-ant-YOUR_REAL_KEY_HERE
FRONTEND_URL=*
PORT=3001
FREE_MONTHLY_LIMIT=2
```

Get your Anthropic key from: https://console.anthropic.com → API Keys

---

## Step 3 — Run locally (for testing)

**Terminal 1 — start the backend:**
```bash
cd resumeforge/backend
npm start
```
You'll see: ✅ ResumeForge backend running on port 3001

**Terminal 2 — open the frontend:**
Just open `resumeforge/frontend/index.html` in your browser (double-click it).
The frontend is already pointed to http://localhost:3001 by default.

Test it — fill in experience + role and hit Generate. It should work!

---

## Step 4 — Deploy the backend to the internet (FREE)

### Option A: Render.com (recommended — easiest)
1. Go to https://render.com → Sign up free
2. Click "New Web Service" → Connect your GitHub repo
3. Set:
   - Build command: `npm install`
   - Start command: `node server.js`
4. Add Environment Variables (same as your .env file)
5. Deploy — you get a URL like: `https://resumeforge-api.onrender.com`

### Option B: Railway.app
1. https://railway.app → New Project → Deploy from GitHub
2. Add environment variables in the dashboard
3. Done — free tier available

### Option C: Your own VPS (DigitalOcean/AWS)
```bash
# On the server:
git clone your-repo
cd resumeforge/backend
npm install
# Install PM2 to keep it running
npm install -g pm2
pm2 start server.js --name resumeforge
pm2 save
```

---

## Step 5 — Deploy the frontend

After backend is live, open `frontend/index.html` and update this line:
```javascript
const BACKEND_URL = "https://resumeforge-api.onrender.com"; // your Render URL
```

Then deploy the frontend:

### Option A: Netlify (drag & drop — easiest)
1. https://netlify.com → drag the `frontend/` folder onto the deploy zone
2. Live instantly at a free .netlify.app URL

### Option B: GitHub Pages
1. Push the frontend/index.html to a GitHub repo as `index.html`
2. Settings → Pages → Enable → Done

---

## Step 6 — Add Razorpay payments

1. Sign up at https://razorpay.com (free, Indian payments)
2. Dashboard → API Keys → Copy your `key_id`
3. In `frontend/index.html`, replace the `handlePayment()` function:

```javascript
function handlePayment(plan) {
  const options = {
    key: "rzp_live_YOURKEY",          // your Razorpay key_id
    amount: plan === 'pro' ? 49900 : 19900,  // in paise
    currency: "INR",
    name: "ResumeForge",
    description: plan === 'pro' ? "Pro Monthly" : "Single Resume",
    handler: function(response) {
      // Payment successful — store isPro in localStorage or call your backend
      alert("Payment successful! " + response.razorpay_payment_id);
    },
    prefill: { name: "", email: "" },
    theme: { color: "#c9a84c" }
  };
  const rzp = new Razorpay(options);
  rzp.open();
}
```

Also add this script tag in the HTML `<head>`:
```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

---

## Revenue Potential

| Users | Revenue/month |
|-------|--------------|
| 100 Pro subscribers | ₹49,900 |
| 200 Pro subscribers | ₹99,800 |
| 500 Pro subscribers | ₹2,49,500 |

API cost per resume: ~₹0.40–0.60
Your price per resume: ₹199
Margin: ~400x

---

## Support
Built with Claude AI by Anthropic.
Questions? Customize server.js for your own features.
