# Notion Intel Scanner

Automated daily news scanner for cannabis accessories business intelligence. Creates Notion signals from relevant news articles.

**Cost: $0** - Uses GitHub Actions (unlimited for public repos)

## What It Does

- 🕐 Runs daily at 6 AM UTC (10 PM PST)
- 📰 Scans RSS feeds from MJBizDaily, Marijuana Moment, Leafly, etc.
- 🔍 Matches articles against business keywords (competitors, regulations, tariffs)
- 📝 Creates Notion signals with rich content for matched articles
- 🚫 Skips duplicates automatically

## Quick Setup (5 minutes)

### 1. Fork or Clone This Repo

Click "Fork" or:
```bash
git clone https://github.com/YOUR_USERNAME/notion-intel-scanner.git
```

### 2. Add GitHub Secrets

Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret | Description | Example |
|--------|-------------|---------|
| `NOTION_TOKEN` | Your Notion integration token | `ntn_xxxx...` or `secret_xxxx...` |
| `SIGNALS_DATABASE_ID` | Notion signals database ID | `2ec3b35e-078c-814c-9fc9-c2088fab109a` |
| `SERPAPI_KEY` | *(Optional)* SerpAPI key for Google News | `abc123...` |

### 3. Make Repo Public

**Settings** → **General** → **Change visibility** → **Make public**

(This gives you unlimited free GitHub Actions minutes)

### 4. Test It

Go to **Actions** → **Daily Intel Scan** → **Run workflow**

## Where to Get Your Values

### NOTION_TOKEN
1. Go to https://www.notion.so/my-integrations
2. Create or select an integration
3. Copy the "Internal Integration Secret"

### SIGNALS_DATABASE_ID
1. Open your Notion signals database
2. Click **Share** → **Copy link**
3. Extract the ID from the URL: `notion.so/YOUR_ID?v=...`

### SERPAPI_KEY (Optional)
1. Sign up at https://serpapi.com
2. Get 100 free searches/month
3. Copy API key from dashboard

## Customization

### Change Schedule

Edit `.github/workflows/daily-scan.yml`:
```yaml
schedule:
  - cron: '0 6 * * *'  # 6 AM UTC daily
```

Common schedules:
- `'0 6 * * *'` - Daily at 6 AM UTC
- `'0 */12 * * *'` - Every 12 hours
- `'0 6 * * 1-5'` - Weekdays only

### Add Keywords

Edit `scanner.js` → `MONITOR_KEYWORDS`:
```javascript
const MONITOR_KEYWORDS = {
  competitors: ['puffco', 'your-competitor-here'],
  // Add your own categories
  custom: ['keyword1', 'keyword2'],
};
```

### Add RSS Feeds

Edit `scanner.js` → `RSS_FEEDS`:
```javascript
const RSS_FEEDS = [
  { name: 'New Source', url: 'https://example.com/feed/', category: 'news' },
];
```

## Local Testing

```bash
# Install
npm install

# Set environment variables
export NOTION_TOKEN=your_token
export SIGNALS_DATABASE_ID=your_db_id

# Dry run (no signals created)
npm test

# Real run
npm run scan
```

## Monitoring

- **View runs**: Go to **Actions** tab in GitHub
- **Check logs**: Click any workflow run
- **New signals**: Look for 📰 emoji in your Notion database

## License

MIT
