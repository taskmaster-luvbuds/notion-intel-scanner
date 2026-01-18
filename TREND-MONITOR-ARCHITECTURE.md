# INTEL Trend Monitors v2 - Architecture & Implementation

## Overview

The Trend Monitor system automates the process of tracking search/news trends for specific terms and creating alerts when significant changes occur. It integrates with the existing INTEL Signals v2 system to create actionable intelligence.

## Database Schema (Notion)

### INTEL Trend Monitors v2 Database

| Property | Type | Description | Example |
|----------|------|-------------|---------|
| `monitor_id` | Title | Unique identifier | `critical-mon-1768701594215-13` |
| `active` | Checkbox | Whether monitor is active | true/false |
| `created_at` | Date | Creation timestamp | 2025-01-15 |
| `interval` | Select | Check frequency | `week` or `month` |
| `last_check` | Date | Last analysis timestamp | 2025-01-18 |
| `terms` | Rich Text | Comma-separated search terms | `India smoking accessories, Finzabad glass` |
| `threshold` | Number | Alert threshold (%) | 20 |
| `trend_score` | Number | Current trend score (0-100) | 65 |
| `trend_change` | Number | % change from last check | +15 |

## System Architecture

```
+------------------+     +-------------------+     +------------------+
|   Notion DB      |     |   Trend Monitor   |     |   Data Sources   |
| (Trend Monitors) |<--->|     (Node.js)     |<--->|                  |
+------------------+     +-------------------+     +------------------+
        |                        |                         |
        |                        |                 +-------+-------+
        v                        v                 |       |       |
+------------------+     +-------------------+     v       v       v
|   Notion DB      |     |  GitHub Actions   |   Google  News   SerpAPI
| (INTEL Signals)  |     |   (Scheduler)     |   Trends  Data   (Google
+------------------+     +-------------------+   RSS     .io     News)
```

## Data Sources (Free Tier Options)

### 1. Google Trends RSS (FREE - No API Key)
- **URL**: `https://trends.google.com/trending/rss?geo=US`
- **Rate Limit**: Reasonable usage
- **Data**: Current trending topics with approximate traffic
- **Use Case**: Detect if monitored terms are currently trending

### 2. NewsData.io (FREE - 200 credits/day)
- **Endpoint**: `https://newsdata.io/api/1/news`
- **Free Tier**: 200 API credits/day, 10 articles per credit
- **Rate Limit**: 30 requests per 15 minutes
- **Data**: News articles with publication dates, sources
- **Use Case**: Measure news volume for specific terms

### 3. SerpAPI Google News (FREE - 100 searches/month)
- **Endpoint**: `https://serpapi.com/search.json?engine=google_news`
- **Free Tier**: 100 searches/month
- **Data**: Google News results with sources, snippets
- **Use Case**: Comprehensive news coverage analysis

### 4. Alternative: trendspyg (Python)
If you prefer Python, use the [trendspyg](https://github.com/flack0x/trendspyg) library:
```python
from trendspyg import download_google_trends_rss
trends = download_google_trends_rss(geo='US')
```

## Key Functions

### Core Operations

```javascript
// 1. Fetch active monitors from Notion
async function fetchActiveMonitors()
// Returns: Array of monitor objects with terms, thresholds, intervals

// 2. Check if monitor interval has elapsed
function shouldCheck(monitor)
// Returns: boolean - true if due for check

// 3. Analyze trends for a monitor
async function analyzeMonitorTrends(monitor)
// Returns: { trendScore, changePercent, articles, confidence }

// 4. Calculate combined trend score
function calculateTrendScore(googleTrends, newsData, serpResults, previousScore)
// Returns: normalized score 0-100 and change percentage

// 5. Update monitor in Notion
async function updateMonitor(pageId, results)
// Updates: last_check, trend_score, trend_change

// 6. Create alert signal when threshold exceeded
async function createAlert(monitor, trendData)
// Creates: New signal in INTEL Signals database
```

### Data Fetching

```javascript
// Google Trends RSS (free)
async function fetchGoogleTrendsRSS(geo = 'US')

// NewsData.io (requires API key)
async function fetchNewsVolume(searchTerms, days = 7)

// SerpAPI Google News (requires API key)
async function fetchGoogleNews(searchTerms)
```

## Trend Scoring Algorithm

The system combines multiple data sources into a normalized score (0-100):

```javascript
Score Components:
- Google Trends presence: 0-20 points
- NewsData.io volume: 0-40 points (normalized by article count)
- SerpAPI news coverage: 0-40 points (normalized by result count)

Final Score = (Sum of components / data sources used) * normalization factor

Change % = ((current_score - previous_score) / previous_score) * 100
```

### Threshold Logic

```javascript
if (Math.abs(changePercent) >= monitor.threshold) {
  // Create alert in INTEL Signals database
  createAlert(monitor, trendData);
}
```

## GitHub Actions Workflow

### Schedule
- **Weekly**: Mondays at 7 AM UTC (for `week` interval monitors)
- **Manual**: Can be triggered via workflow_dispatch

### Required Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `NOTION_TOKEN` | Yes | Notion integration token |
| `MONITORS_DATABASE_ID` | Yes | Trend Monitors database ID |
| `SIGNALS_DATABASE_ID` | No | For creating alerts |
| `NEWSDATA_API_KEY` | No | NewsData.io API key |
| `SERPAPI_KEY` | No | SerpAPI key |

## Setup Instructions

### 1. Configure Notion Database

Ensure your INTEL Trend Monitors v2 database has these properties:
- `monitor_id` (Title)
- `active` (Checkbox)
- `created_at` (Date)
- `interval` (Select: "week", "month")
- `last_check` (Date)
- `terms` (Rich Text)
- `threshold` (Number)
- Optional: `trend_score` (Number), `trend_change` (Number)

### 2. Add GitHub Secrets

```bash
# Required
NOTION_TOKEN=ntn_xxxxx
MONITORS_DATABASE_ID=your-database-id

# Optional (for alerts)
SIGNALS_DATABASE_ID=your-signals-db-id

# Optional (enhance data sources)
NEWSDATA_API_KEY=your-newsdata-key  # Get at newsdata.io
SERPAPI_KEY=your-serpapi-key        # Get at serpapi.com
```

### 3. Run Locally (Testing)

```bash
# Install dependencies
npm install

# Set environment variables
export NOTION_TOKEN=your_token
export MONITORS_DATABASE_ID=your_db_id

# Dry run (no Notion updates)
npm run trends:test

# Real run
npm run trends
```

### 4. Enable GitHub Actions

The workflow runs automatically on Mondays. To run manually:
1. Go to Actions tab
2. Select "Trend Monitor Scan"
3. Click "Run workflow"

## Cost Analysis

### Completely Free Option
- Google Trends RSS only
- Provides basic trending topic detection
- No API keys required

### Enhanced Free Tier
- Google Trends RSS (free)
- NewsData.io (200 credits/day = 2,000 articles/day free)
- SerpAPI (100 searches/month free)

**Monthly Cost: $0** if staying within free tiers

### Recommended for Production
- NewsData.io Basic: $79/month (20,000 credits)
- SerpAPI Developer: $75/month (5,000 searches)

## Signal Output Format

When a threshold is exceeded, an alert is created in the INTEL Signals database:

```javascript
{
  signal_id: "trend-alert-1705123456789-abc1",
  entity: "India smoking accessories, Finzabad glass",
  signal_type: "TREND",
  content: "Trend alert: India smoking accessories: Score 75, Change +35%",
  source: "Monitor: critical-mon-1768701594215-13",
  confidence: 0.8,
  timestamp: "2025-01-18",
  processed: false
}
```

## Extending the System

### Add New Data Sources

```javascript
// Example: Add Reddit mentions
async function fetchRedditMentions(terms) {
  // Use Pushshift API or Reddit API
  const results = [];
  for (const term of terms) {
    const response = await fetch(
      `https://api.pushshift.io/reddit/search/submission/?q=${term}&size=100`
    );
    // Process results...
  }
  return results;
}

// Add to calculateTrendScore()
function calculateTrendScore(googleTrends, newsData, serpResults, redditData, previousScore) {
  // Include reddit factor in scoring
}
```

### Add Historical Tracking

Store trend scores over time by adding a "trend_history" property (JSON) or creating a separate history database:

```javascript
// In updateMonitor()
const history = JSON.parse(existingHistory || '[]');
history.push({
  date: new Date().toISOString(),
  score: results.trendScore,
  change: results.trendChange
});
// Keep last 52 weeks
const recentHistory = history.slice(-52);
```

## Troubleshooting

### Common Issues

1. **"Rate limited" errors**
   - Increase sleep times between API calls
   - Reduce number of monitors checked per run

2. **"No data sources available"**
   - At minimum, Google Trends RSS should work
   - Check API keys if using NewsData.io or SerpAPI

3. **Monitors not being checked**
   - Verify `active` checkbox is true
   - Check `interval` vs `last_check` timing

4. **Alerts not being created**
   - Verify `SIGNALS_DATABASE_ID` is set
   - Check threshold values (absolute change must exceed)

## References

- [trendspyg Library](https://github.com/flack0x/trendspyg) - Python Google Trends alternative
- [NewsData.io Documentation](https://newsdata.io/documentation)
- [SerpAPI Google Trends](https://serpapi.com/google-trends-api)
- [Notion API](https://developers.notion.com/)
