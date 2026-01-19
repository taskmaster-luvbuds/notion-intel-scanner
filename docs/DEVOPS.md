# DevOps Guide - Notion Intel Scanner

This document covers deployment, operations, and maintenance for the Notion Intel Scanner and Trend Monitor applications.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Environment Setup](#environment-setup)
4. [Running the Application](#running-the-application)
5. [Monitoring and Logging](#monitoring-and-logging)
6. [Troubleshooting](#troubleshooting)
7. [Rate Limits](#rate-limits)
8. [Health Checks](#health-checks)
9. [Backup and Recovery](#backup-and-recovery)

---

## Prerequisites

### Node.js Version

- **Required**: Node.js >= 18.0.0
- **Recommended**: Node.js 22.x (LTS)
- The `engines` field in `package.json` enforces this requirement

Verify your Node.js version:

```bash
node --version
# Expected: v18.0.0 or higher
```

### npm Dependencies

The application requires the following npm packages:

| Package | Version | Purpose |
|---------|---------|---------|
| `@notionhq/client` | ^2.2.14 | Notion API client for database operations |
| `rss-parser` | ^3.13.0 | Parse RSS feeds from news sources |

### System Requirements

- **OS**: Linux (Ubuntu recommended for production), macOS, or Windows
- **Memory**: 512MB minimum, 1GB recommended
- **Network**: Outbound HTTPS access to:
  - `api.notion.com` (Notion API)
  - `trends.google.com` (Google Trends RSS)
  - `news.google.com` (Google News RSS)
  - `newsdata.io` (NewsData API - optional)
  - `serpapi.com` (SerpAPI - optional)
  - `reddit.com` (Reddit JSON API)
  - `hn.algolia.com` (HackerNews API)

---

## Installation

### Step 1: Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/notion-intel-scanner.git
cd notion-intel-scanner
```

### Step 2: Install Dependencies

```bash
npm install
```

Or for a clean install (recommended for CI/CD):

```bash
npm ci
```

### Step 3: Create Environment File

```bash
cp .env.example .env
```

### Step 4: Configure Environment Variables

Edit `.env` with your credentials (see [Environment Setup](#environment-setup) below).

### Step 5: Verify Installation

```bash
# Test trend monitor (dry run)
npm run trends:test

# Test scanner (dry run)
npm test
```

---

## Environment Setup

### Required Environment Variables

| Variable | Description | How to Obtain |
|----------|-------------|---------------|
| `NOTION_TOKEN` | Notion API integration token | [notion.so/my-integrations](https://www.notion.so/my-integrations) - Create integration, copy "Internal Integration Token" |
| `MONITORS_DATABASE_ID` | Notion database ID for trend monitors (required for trend-monitor.js) | From Notion database URL: `notion.so/[DATABASE_ID]?v=...` |
| `SIGNALS_DATABASE_ID` | Notion database ID for signals output (required for scanner.js) | From Notion database URL: `notion.so/[DATABASE_ID]?v=...` |

### Optional Environment Variables

| Variable | Description | Free Tier Limits | How to Obtain |
|----------|-------------|------------------|---------------|
| `NEWSDATA_API_KEY` | NewsData.io API key for additional news sources | 200 credits/day | [newsdata.io](https://newsdata.io/) - Sign up and get API key |
| `SERPAPI_KEY` | SerpAPI key for Google News search | 100 searches/month | [serpapi.com](https://serpapi.com/) - Sign up and get API key |
| `VERBOSE` | Enable detailed factor breakdowns in console output | N/A | Set to `true` to enable |
| `DRY_RUN` | Test mode - no changes made to Notion | N/A | Set to `true` for testing |

### Example .env File

```bash
# Required
NOTION_TOKEN=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MONITORS_DATABASE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
SIGNALS_DATABASE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Optional - Enhanced data sources
NEWSDATA_API_KEY=your_newsdata_api_key
SERPAPI_KEY=your_serpapi_key

# Optional - Execution modes
DRY_RUN=false
VERBOSE=false
```

### Notion Integration Setup

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click "New integration"
3. Name it (e.g., "Intel Scanner")
4. Select the workspace
5. Copy the "Internal Integration Token"
6. **Important**: Share your Notion databases with the integration:
   - Open each database in Notion
   - Click "Share" in the top right
   - Invite your integration by name

---

## Running the Application

### Manual Execution

#### Trend Monitor

```bash
# Full run - updates Notion with trend analysis
npm run trends

# Dry run - test without making changes
npm run trends:test

# Verbose mode - show detailed factor breakdowns
VERBOSE=true npm run trends

# Direct execution
node trend-monitor.js
node trend-monitor.js --dry-run
```

#### Daily Scanner

```bash
# Full run - creates signals in Notion
npm run scan

# Dry run - test without creating signals
npm test

# Direct execution
node scanner.js
node scanner.js --dry-run
```

#### Backfill Scores

```bash
# Backfill historical scores
npm run backfill

# Test backfill
npm run backfill:test
```

### Scheduled Execution (Cron)

#### Local Cron Setup

Add to crontab (`crontab -e`):

```bash
# Trend Monitor - Daily at 7 AM UTC
0 7 * * * cd /path/to/notion-intel-scanner && /usr/local/bin/node trend-monitor.js >> /var/log/trend-monitor.log 2>&1

# Daily Scanner - Daily at 6 AM UTC
0 6 * * * cd /path/to/notion-intel-scanner && /usr/local/bin/node scanner.js >> /var/log/scanner.log 2>&1
```

**Note**: Ensure environment variables are available to cron. Either:
- Source the `.env` file in your cron command
- Use a wrapper script that loads environment variables
- Set variables directly in crontab

Example wrapper script:

```bash
#!/bin/bash
cd /path/to/notion-intel-scanner
source .env
export NOTION_TOKEN MONITORS_DATABASE_ID SIGNALS_DATABASE_ID
node trend-monitor.js
```

### GitHub Actions Setup

The repository includes pre-configured GitHub Actions workflows.

#### Required Secrets

Add these in your GitHub repository: **Settings > Secrets and variables > Actions > New repository secret**

| Secret | Required | Description |
|--------|----------|-------------|
| `NOTION_TOKEN` | Yes | Notion API token |
| `MONITORS_DATABASE_ID` | Yes (for Trend Monitor) | Monitors database ID |
| `SIGNALS_DATABASE_ID` | Yes (for Scanner) | Signals database ID |
| `NEWSDATA_API_KEY` | No | NewsData.io API key |
| `SERPAPI_KEY` | No | SerpAPI key |

#### Workflow Schedules

| Workflow | Schedule | Description |
|----------|----------|-------------|
| `daily-scan.yml` | 6 AM UTC daily | Scans RSS feeds, creates signals |
| `trend-monitor.yml` | 7 AM UTC daily | Analyzes trends, updates monitors |

#### Manual Trigger

Both workflows support manual triggering via `workflow_dispatch`:

1. Go to **Actions** tab in GitHub
2. Select the workflow (Daily Intel Scan or Trend Monitor Scan)
3. Click **Run workflow**
4. Optionally enable "Dry run" mode
5. Click **Run workflow**

#### Customizing the Schedule

Edit the workflow files in `.github/workflows/`:

```yaml
on:
  schedule:
    - cron: '0 7 * * *'  # Modify this cron expression
```

Common cron patterns:

| Pattern | Description |
|---------|-------------|
| `'0 6 * * *'` | Daily at 6 AM UTC |
| `'0 */12 * * *'` | Every 12 hours |
| `'0 6 * * 1-5'` | Weekdays only at 6 AM UTC |
| `'0 6,18 * * *'` | 6 AM and 6 PM UTC |

---

## Monitoring and Logging

### Console Output

The Trend Monitor provides structured console output:

```
======================================================================
           NOTION INTEL TREND MONITOR v2
           Multi-Factor Scoring with Coherence
======================================================================

Started: 2024-01-15T07:00:00.000Z
Mode: DRY RUN (no updates will be made)
Mode: VERBOSE (detailed factor breakdowns)

Data Sources:
  - Google Trends RSS: Available (regions: US, GB, CA, AU)
  - Google News RSS: Available (FREE - no API key required)
  - NewsData.io: Configured
  - SerpAPI: Configured

Testing Notion connection...
Notion connection successful

Step 1: Fetching active monitors...
  Found 5 active monitors

Step 2: Checking intervals...
  3 monitors due for check

Step 3: Analyzing trends...
  [Monitor details and results...]

======================================================================
SUMMARY
======================================================================
Total active monitors:   5
Monitors checked:        3
Alerts created:          1
Errors:                  0
Completed:               2024-01-15T07:05:00.000Z
```

### Verbose Mode

Enable detailed factor breakdowns:

```bash
VERBOSE=true npm run trends
```

Verbose output includes:

- Individual factor scores (velocity, momentum, sentiment, relevance, authority, recency)
- Source-by-source article counts
- Coherence calculation breakdown
- EMA smoothing values
- Regional data summaries

### Log Files

For production deployments, redirect output to log files:

```bash
# With timestamps
node trend-monitor.js 2>&1 | while IFS= read -r line; do echo "$(date '+%Y-%m-%d %H:%M:%S') $line"; done >> /var/log/trend-monitor.log
```

### GitHub Actions Logs

- Navigate to **Actions** tab
- Click on a workflow run
- Click on the job (e.g., "trend-scan")
- Expand each step to view logs
- Download full logs via the gear icon > "Download log archive"

### Key Metrics to Watch

| Metric | Normal Range | Action if Abnormal |
|--------|--------------|-------------------|
| Monitors checked | All active monitors | Check interval settings |
| Errors | 0 | Review error messages |
| Alerts created | Varies | Adjust thresholds if too many/few |
| Execution time | < 30 minutes | Check for rate limiting |

---

## Troubleshooting

### Common Errors and Solutions

#### Error: NOTION_TOKEN environment variable not set

**Cause**: Missing or unset `NOTION_TOKEN`

**Solution**:
```bash
export NOTION_TOKEN=your_token_here
# Or add to .env file
```

#### Error: MONITORS_DATABASE_ID environment variable not set

**Cause**: Missing database ID for trend monitors

**Solution**:
```bash
export MONITORS_DATABASE_ID=your_database_id
```

#### Error: Could not find database with ID

**Cause**: Database not shared with integration

**Solution**:
1. Open the database in Notion
2. Click "Share" button
3. Invite your integration by name
4. Verify the database ID is correct

#### Error: Rate limited, waiting Xms...

**Cause**: Too many API requests

**Solution**: The application handles this automatically with exponential backoff. If persistent:
- Reduce the number of monitors
- Increase sleep intervals between requests
- Check if multiple instances are running

#### Error: Request timed out after 10000ms

**Cause**: Network issues or slow API response

**Solution**:
- Check internet connectivity
- Verify API endpoints are accessible
- Try again later (may be temporary)

#### Error: property does not exist

**Cause**: Notion database missing required properties

**Solution**: Add the following properties to your Monitors database:
- `trend_score` (Number)
- `Coherency` (Number)
- `confidence` (Number)
- `change_percent` (Number)
- `top_articles` (Rich Text)
- `source_urls` (Rich Text)
- `regions_data` (Rich Text)
- `summary` (Rich Text)

#### No monitors found / 0 active monitors

**Cause**: No monitors with `active` checkbox enabled

**Solution**:
1. Open your Monitors database in Notion
2. Ensure monitors have the `active` checkbox checked
3. Verify the database ID is correct

### Debug Mode

For deeper debugging, add console.log statements or use Node.js debugging:

```bash
# Node.js inspector
node --inspect trend-monitor.js

# Or with breakpoints
node --inspect-brk trend-monitor.js
```

### GitHub Actions Failures

When workflows fail:

1. Check the **Actions** tab for error details
2. Look for automatically created issues labeled `workflow-failure`
3. Common causes:
   - Missing secrets
   - API rate limits
   - Notion database permission issues

---

## Rate Limits

### API Rate Limits by Data Source

| Data Source | Rate Limit | Notes |
|-------------|------------|-------|
| **Notion API** | 3 requests/second | Application includes exponential backoff (2^n seconds on 429) |
| **Google Trends RSS** | No official limit | 300ms delay between regions enforced |
| **Google News RSS** | No official limit | 300ms delay between terms enforced |
| **NewsData.io** | 200 credits/day (free tier) | Limited to 5 terms per run |
| **SerpAPI** | 100 searches/month (free tier) | Limited to 3 terms per run (conservative) |
| **Reddit JSON API** | ~60 requests/minute | 500ms delay between terms enforced |
| **HackerNews Algolia** | Unlimited (generous) | 300ms delay between terms enforced |

### Built-in Rate Limiting

The application includes these safeguards:

```javascript
// Between monitors
await sleep(1000);  // 1 second delay

// Between API calls
await sleep(100);   // 100ms for Notion block operations
await sleep(300);   // 300ms for Google/HackerNews
await sleep(500);   // 500ms for Reddit/NewsData
await sleep(1000);  // 1s for SerpAPI
```

### Timeout Settings

```javascript
const FETCH_TIMEOUT_MS = 10000;  // 10 seconds per request
```

### Avoiding Rate Limits

1. **Run at off-peak times**: Schedule for early morning UTC
2. **Limit monitor count**: Keep active monitors reasonable
3. **Use free sources**: Google Trends RSS and Google News RSS have no limits
4. **Monitor API usage**: Track NewsData and SerpAPI credit consumption

---

## Health Checks

### Quick Health Check

Run a dry test to verify all systems:

```bash
npm run trends:test
```

Expected output:
- "Notion connection successful"
- "Found X active monitors"
- No fatal errors

### Component Health Checks

#### Notion Connection

```bash
node -e "
const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_TOKEN });
notion.databases.retrieve({ database_id: process.env.MONITORS_DATABASE_ID })
  .then(() => console.log('Notion: OK'))
  .catch(e => console.error('Notion: FAILED -', e.message));
"
```

#### RSS Feed Accessibility

```bash
# Google Trends RSS
curl -s -o /dev/null -w "%{http_code}" "https://trends.google.com/trends/trendingsearches/daily/rss?geo=US"
# Expected: 200

# Google News RSS
curl -s -o /dev/null -w "%{http_code}" "https://news.google.com/rss/search?q=test&hl=en-US"
# Expected: 200
```

#### Optional APIs

```bash
# NewsData.io (if configured)
curl -s "https://newsdata.io/api/1/news?apikey=$NEWSDATA_API_KEY&q=test" | jq '.status'
# Expected: "success"

# SerpAPI (if configured)
curl -s "https://serpapi.com/account?api_key=$SERPAPI_KEY" | jq '.account_email'
# Expected: your email
```

### Automated Health Monitoring

For production, consider setting up:

1. **Uptime monitoring**: Monitor GitHub Actions workflow success rate
2. **Alert on failure**: GitHub Actions creates issues on failure automatically
3. **Log aggregation**: Centralize logs for analysis
4. **API credit monitoring**: Track NewsData/SerpAPI usage

---

## Backup and Recovery

### Score History Persistence

**Current Implementation**: Score history is stored in-memory per run using a `Map()` object:

```javascript
const scoreHistory = new Map();
```

This means:
- Scores persist within a single execution
- Previous scores are loaded from Notion database properties at startup
- EMA smoothing uses the previous score stored in Notion

**Recovery**: If a monitor's score history is lost:
1. The next run will treat the current score as the first observation
2. EMA smoothing will restart from this baseline
3. No historical data is permanently lost (it's in Notion)

### Notion Data Backup

The Notion database serves as the primary data store. Backup strategies:

#### Manual Export

1. Open your Notion workspace
2. **Settings & members > Settings > Export content**
3. Choose format (Markdown or CSV)
4. Download the export

#### Automated Backup

Use the Notion API to periodically export data:

```javascript
// Example: Export monitors to JSON
const monitors = await notion.databases.query({
  database_id: MONITORS_DATABASE_ID,
});
fs.writeFileSync(
  `backup-${Date.now()}.json`,
  JSON.stringify(monitors.results, null, 2)
);
```

### Recovery Procedures

#### Restore Monitor Configuration

1. Re-create monitors in Notion database with required properties
2. Set `active` checkbox to true
3. Run `npm run trends` to repopulate scores

#### Restore from Backup

1. Import backup data to Notion (manually or via API)
2. Verify database properties match requirements
3. Share database with integration
4. Test with `npm run trends:test`

### Database Schema Requirements

Ensure your Notion databases have these properties:

**Monitors Database**:
| Property | Type | Required |
|----------|------|----------|
| `monitor_id` | Title | Yes |
| `terms` | Rich Text | Yes |
| `active` | Checkbox | Yes |
| `threshold` | Number | Yes |
| `interval` | Select | Yes |
| `last_check` | Date | No |
| `trend_score` | Number | No |
| `Coherency` | Number | No |
| `confidence` | Number | No |
| `change_percent` | Number | No |
| `top_articles` | Rich Text | No |
| `source_urls` | Rich Text | No |
| `regions_data` | Rich Text | No |
| `summary` | Rich Text | No |
| `recommendations` | Rich Text | No |

**Signals Database**:
| Property | Type | Required |
|----------|------|----------|
| `signal_id` | Title | Yes |
| `entity` | Rich Text | Yes |
| `signal_type` | Select | Yes |
| `content` | Rich Text | Yes |
| `source` | Rich Text | Yes |
| `confidence` | Number | Yes |
| `timestamp` | Date | Yes |
| `processed` | Checkbox | Yes |

---

## Additional Resources

- [README.md](../README.md) - Overview and quick start
- [CHANGELOG.md](../CHANGELOG.md) - Version history
- [TREND-MONITOR-ARCHITECTURE.md](../TREND-MONITOR-ARCHITECTURE.md) - Technical architecture details
- [SCORING-IMPROVEMENTS.md](../SCORING-IMPROVEMENTS.md) - Scoring system documentation
- [.env.example](../.env.example) - Environment variable template

---

*Last updated: January 2024*
