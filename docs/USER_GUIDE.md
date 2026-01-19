# Notion INTEL Trend Monitor - User Guide

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Configuration](#configuration)
4. [Monitor Setup](#monitor-setup)
5. [Understanding Results](#understanding-results)
6. [Data Sources](#data-sources)
7. [Action Recommendations](#action-recommendations)
8. [Output Examples](#output-examples)

---

## Overview

The **Notion INTEL Trend Monitor** is an automated trend monitoring system that tracks keywords and topics across multiple data sources, calculates sophisticated trend scores, and updates your Notion workspace with actionable intelligence.

### Key Features

- **Multi-Factor Scoring**: Uses 6 weighted factors (velocity, momentum, sentiment, relevance, authority, recency) to calculate comprehensive trend scores
- **Coherence Metric**: Measures signal reliability across data sources (0-100)
- **7 Data Sources**: Aggregates data from Google Trends, Google News RSS, NewsData.io, SerpAPI, Reddit, HackerNews, and BBC/Guardian RSS feeds
- **Sentiment Analysis**: AFINN-111 based sentiment scoring of article headlines
- **Article Deduplication**: Smart deduplication using URL normalization and title similarity (Jaccard coefficient)
- **EMA Smoothing**: Exponential Moving Average smoothing to reduce noise in trend scores
- **Recency Weighting**: Articles lose half their weight every 3 days (exponential decay)
- **Action Recommendations**: AI-generated recommendations based on trend analysis
- **Notion Integration**: Automatically updates monitor pages with rich content blocks

---

## Quick Start

### Run Immediately (Dry Run Mode)

Test the monitor without making any changes to Notion:

```bash
# Using npm script
npm run trends:test

# Or directly
node trend-monitor.js --dry-run
```

### Run in Production Mode

Execute the monitor and update Notion:

```bash
# Using npm script
npm run trends

# Or directly
node trend-monitor.js
```

### Run with Verbose Output

See detailed factor breakdowns:

```bash
VERBOSE=true node trend-monitor.js
```

---

## Configuration

### Environment Variables

Create a `.env` file in the project root (or copy from `.env.example`):

```bash
# ==============================================================================
# REQUIRED - Monitor will not run without these
# ==============================================================================

# Notion API Integration Token
# Get from: https://www.notion.so/my-integrations
NOTION_TOKEN=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Monitors Database ID - where trend monitors are configured
# Get from your Notion database URL: notion.so/xxx?v=yyy (xxx is the ID)
MONITORS_DATABASE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# ==============================================================================
# OPTIONAL - For alerts
# ==============================================================================

# Signals Database ID - where trend alerts are stored (optional)
SIGNALS_DATABASE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# ==============================================================================
# OPTIONAL - Additional Data Sources
# ==============================================================================

# NewsData.io API Key (free tier: 200 credits/day)
# Sign up at: https://newsdata.io/
NEWSDATA_API_KEY=your_newsdata_api_key_here

# SerpAPI Key (free tier: 100 searches/month)
# Sign up at: https://serpapi.com/
SERPAPI_KEY=your_serpapi_key_here

# ==============================================================================
# OPTIONAL - Execution modes
# ==============================================================================

# Dry Run Mode - test without making changes to Notion
DRY_RUN=false

# Verbose Mode - show detailed factor breakdowns
VERBOSE=false
```

### Notion Database Schema

Your **Monitors Database** in Notion needs these properties:

| Property | Type | Description |
|----------|------|-------------|
| `monitor_id` | Title | Unique identifier for the monitor |
| `terms` | Rich Text | Comma-separated search terms |
| `active` | Checkbox | Whether the monitor is active |
| `threshold` | Number | Alert threshold percentage |
| `interval` | Select | Check frequency: `day`, `week`, `month` |
| `last_check` | Date | Last time this monitor was checked |
| `trend_score` | Number | Calculated trend score (0-100) |
| `Coherency` | Number | Signal coherence score (0-100) |
| `confidence` | Number | Confidence percentage (0-100) |
| `change_percent` | Number | Change from previous check |
| `top_articles` | Rich Text | Top 3 article links |
| `source_urls` | Rich Text | URLs that were checked |
| `regions_data` | Rich Text | Regional match summary |
| `summary` | Rich Text | Analysis summary |
| `recommendations` | Rich Text | Action recommendations |

---

## Monitor Setup

### Creating a New Monitor in Notion

1. Open your Monitors database in Notion
2. Create a new page with these properties:
   - **monitor_id**: Give it a unique name (e.g., "cannabis-accessories-trends")
   - **terms**: Enter comma-separated search terms (e.g., "cannabis accessories, smoking gear, Finzabad glass")
   - **active**: Check this box to enable monitoring
   - **threshold**: Set the percentage change that triggers alerts (e.g., 20)
   - **interval**: Choose `day`, `week`, or `month`

### Best Practices for Search Terms

- Use 3-5 specific terms per monitor
- Combine broad and specific terms
- Include industry-specific terminology
- Consider regional variations

**Example Monitor Configuration:**

```
monitor_id: "india-smoking-accessories"
terms: "India smoking accessories, Finzabad glass, hookah pipes India, smoking gear Mumbai"
threshold: 20
interval: week
active: true
```

---

## Understanding Results

### Trend Score (0-100)

The main indicator of trending activity, calculated from 6 weighted factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| Velocity | 20% | Rate of change from previous score |
| Momentum | 20% | Sustained interest across regions |
| Relevance | 20% | Direct term matches in trending topics |
| Authority | 15% | Source credibility weighted by reliability |
| Recency | 15% | Article freshness (exponential decay) |
| Sentiment | 10% | AFINN-based headline sentiment |

**Score Interpretation:**

| Score Range | Meaning |
|-------------|---------|
| 70-100 | Strong trending signal - high activity detected |
| 40-69 | Moderate trending - worth monitoring |
| 0-39 | Low trending activity - topic not currently hot |

---

### Coherence Score and Levels

Measures how consistent the signal is across data sources:

| Score Range | Level | Interpretation |
|-------------|-------|----------------|
| 75-100 | High | Strong agreement across sources - reliable signal |
| 50-74 | Medium | Moderate agreement - likely valid but verify |
| 25-49 | Low | Inconsistent signals - interpret with caution |
| 0-24 | Noise | Very inconsistent - may be false positive |

**Coherence Factors:**

- **Direction Agreement (30%)**: Do sources agree on presence of signal?
- **Magnitude Consistency (25%)**: Similar signal strength across sources?
- **Temporal Consistency (25%)**: Sustained trend or just a spike?
- **Term Correlation (20%)**: Related terms trending together?

**Visual Indicators:**

| Emoji | Level |
|-------|-------|
| Target | High coherence |
| Bar Chart | Medium coherence |
| Lightning | Low coherence / Noise |

---

### Confidence Percentage

Indicates how confident the system is in the trend score:

| Range | Meaning |
|-------|---------|
| 70-98% | High confidence - multiple reliable sources confirm |
| 40-69% | Medium confidence - some data available |
| 10-39% | Low confidence - limited data, interpret carefully |

**Confidence Factors:**

- Source count and reliability weights
- Data freshness (more recent = higher)
- Sample size (more data points = higher)
- Source agreement (coherence multiplier)

---

### Trend Direction Indicators

Visual indicators showing the direction and strength of trend movement:

| Emoji | Change % | Strength | Description |
|-------|----------|----------|-------------|
| Rocket | > +20% | Strong | Strong upward trend |
| Chart Increasing | +10% to +20% | Moderate | Moderate upward trend |
| Arrow Up-Right | +3% to +10% | Weak | Weak upward trend |
| Arrow Right | -3% to +3% | Stable | Stable trend |
| Arrow Down-Right | -3% to -10% | Weak | Weak downward trend |
| Arrow Down | -10% to -20% | Moderate | Moderate downward trend |
| Chart Decreasing | < -20% | Strong | Strong downward trend |

---

### Momentum Trends

Indicates whether the trend is accelerating, steady, or decelerating:

| Momentum | Calculation | Meaning |
|----------|-------------|---------|
| **Accelerating** | Combined score >= 70 | Trend is gaining steam rapidly |
| **Steady** | Combined score 30-69 | Trend is maintaining pace |
| **Decelerating** | Combined score < 30 | Trend is losing momentum |

**How Momentum is Calculated:**

1. **Regional Score (40%)**: Percentage of regions (US, GB, CA, AU) showing matches
2. **Recency Score (60%)**: Compares articles in last 24 hours vs previous 24-48 hours

---

### Sentiment Analysis Scores

AFINN-111 based sentiment analysis of article headlines:

| Score Range | Classification | Interpretation |
|-------------|---------------|----------------|
| 70-100 | Positive | Overwhelmingly positive coverage |
| 56-70 | Somewhat Positive | Generally positive tone |
| 45-55 | Neutral | Balanced or factual coverage |
| 30-45 | Somewhat Negative | Concerning tone detected |
| 0-30 | Negative | Predominantly negative coverage |

**Note:** Sentiment of 50 indicates neutral or no sentiment words detected.

---

## Data Sources

The monitor aggregates data from 7 sources, each with reliability and weight scores:

| Source | Reliability | Weight | API Required | Rate Limit |
|--------|-------------|--------|--------------|------------|
| **Google Trends RSS** | 85% | 14% | No (free) | Multi-region (US, GB, CA, AU) |
| **Google News RSS** | 80% | 14% | No (free) | 300ms between requests |
| **NewsData.io** | 80% | 14% | Yes (free tier) | 200 credits/day |
| **SerpAPI** | 90% | 14% | Yes (free tier) | 100 searches/month |
| **HackerNews** | 85% | 14% | No (free) | Unlimited via Algolia API |
| **Reddit** | 70% | 10% | No (free) | 500ms between requests |
| **Additional RSS** | 80% | 20% | No (free) | BBC, The Guardian |

### Source Details

#### Google Trends RSS (Free)
- **Endpoint**: `https://trends.google.com/trending/rss?geo={region}`
- **Regions**: US, GB, CA, AU
- **Returns**: Daily trending searches with traffic estimates

#### Google News RSS (Free)
- **Endpoint**: `https://news.google.com/rss/search?q={term}`
- **Returns**: Recent news articles matching search terms
- **Features**: Extracts source name from title

#### NewsData.io (Free Tier)
- **Endpoint**: `https://newsdata.io/api/1/news`
- **Requires**: API key (200 credits/day free)
- **Returns**: Global news with metadata

#### SerpAPI (Free Tier)
- **Endpoint**: `https://serpapi.com/search.json?engine=google_news`
- **Requires**: API key (100 searches/month free)
- **Returns**: Google News results with rich metadata

#### HackerNews (Free)
- **Endpoint**: `https://hn.algolia.com/api/v1/search?query={term}&tags=story`
- **Returns**: Stories with points and comment counts
- **Note**: Great for tech/startup topics

#### Reddit (Free)
- **Endpoint**: `https://www.reddit.com/search.json`
- **Returns**: Posts with scores, comments, subreddit info
- **Note**: 70% reliability (social media noise)

#### Additional RSS - BBC & Guardian (Free)
- **BBC**: `https://feeds.bbci.co.uk/news/rss.xml`
- **Guardian**: `https://www.theguardian.com/world/rss`
- **Returns**: High-quality journalism, filtered by search terms

---

## Action Recommendations

The system generates prioritized recommendations based on trend analysis:

### Priority Levels

| Priority | Emoji | Trigger Conditions |
|----------|-------|-------------------|
| **High** | Red Circle | Trend Score > 70 AND Coherence > 60, OR Confidence > 70 |
| **Medium** | Yellow Circle | Trend Score 40-70, OR Coherence 40-60, OR sentiment alerts |
| **Low** | Green Circle | Trend Score < 40, OR low confidence, OR no significant signals |

### Recommendation Types

#### High Priority Actions (Act Now)
- "Create content about {term} - high trending activity detected"
- "Consider market entry - strong positive signal across sources"
- "Monitor competitor activity - trend gaining momentum"
- "High confidence signal - action recommended"

#### Medium Priority Actions (Monitor)
- "Track this trend - moderate activity detected"
- "Research deeper - mixed signals need clarification"
- "Set up alerts - potential emerging opportunity"
- "Caution: Negative sentiment detected"
- "Positive sentiment - favorable environment"

#### Low Priority Actions (Routine)
- "Continue monitoring - no significant activity"
- "Review search terms - may need refinement"
- "Check back next cycle - insufficient data"
- "Low confidence - gather more data before acting"

---

## Output Examples

### Console Output

```
======================================================================
           NOTION INTEL TREND MONITOR v2
           Multi-Factor Scoring with Coherence
======================================================================

Started: 2026-01-19T14:30:00.000Z
Mode: VERBOSE (detailed factor breakdowns)

Data Sources:
  - Google Trends RSS: Available (regions: US, GB, CA, AU)
  - Google News RSS: Available (FREE - no API key required)
  - NewsData.io: Configured
  - SerpAPI: Not configured

Scoring v2 Features:
  - 6-factor trend scoring (velocity, momentum, sentiment, relevance, authority, recency)
  - Coherence metric (signal quality 0-100)
  - EMA smoothing and recency weighting

Testing Notion connection...
Notion connection successful

Step 1: Fetching active monitors...
  Found 3 active monitors

Step 2: Checking intervals...
  2 monitors due for check

Step 3: Analyzing trends...

  Analyzing: india-smoking-accessories
  Terms: India smoking accessories, Finzabad glass
  Regions checked: US:0, GB:1, CA:0, AU:0
  Google News RSS: 12 articles found
  Reddit: 5 posts found
  HackerNews: 3 stories found
  Additional RSS (BBC, Guardian): 2 articles found
  Coherence: 65 (Medium)
  Trend Score: 58 (raw: 62, smoothed: 58)
  Change: 12%
  Confidence: 72
  Data Sources: 5
  Factors: V=56 M=45 S=52 R=50 A=68 Re=71
  Deduplication: 22 -> 18 articles

======================================================================
SUMMARY
======================================================================
Total active monitors:   3
Monitors checked:        2
Alerts created:          1
Errors:                  0
Completed:               2026-01-19T14:32:45.000Z
```

### Notion Page Content Update

When the monitor runs, it updates your Notion page with rich content blocks:

---

#### Trend Analysis Report

Last Updated: 2026-01-19

#### Monitor Details
- **Terms:** India smoking accessories, Finzabad glass
- **Interval:** week
- **Threshold:** 20%

#### Scoring Metrics
- **Trend Score:** 58/100
- **Bar Chart Coherence:** 65/100 (Medium)
- **Confidence:** 72%
- **Change:** 12%
- **Trend Direction:** Chart Increasing Moderate upward trend (moderate)
- **Momentum:** Steady

#### Data Sources Checked
- Google Trends RSS (US, GB, CA, AU): US:0, GB:1, CA:0, AU:0
- Google News RSS: 12 articles found
- Data sources used: 5

#### Top Related Articles
1. [India's smoking accessories market sees 15% growth](https://example.com/article1)
2. [Finzabad glass exports increase amid global demand](https://example.com/article2)
3. [New regulations affect hookah pipe imports](https://example.com/article3)

#### Recommended Actions
- Yellow Circle Track this trend - moderate activity detected
- Yellow Circle Positive sentiment - favorable environment
- Green Circle Set up alerts - potential emerging opportunity

#### Summary
Found 1 matching trend in Google Trends. 12 articles from Google News RSS. 2 articles from BBC/Guardian.

This indicates moderate trending activity. Worth monitoring for changes. The medium coherence score suggests moderate agreement across sources.

---

#### Score Factor Breakdown
Velocity: 56 | Momentum: 45 | Sentiment: 52 | Relevance: 50 | Authority: 68 | Recency: 71

---

### Alert Signal (When Threshold Exceeded)

When the change percentage exceeds your threshold, an alert is created in the Signals database:

```
Trend Alert

Warning: Threshold exceeded: 25% change (threshold: 20%)

Scoring Metrics
- Trend Score: 72 (raw: 75)
- Target Coherence: 78 (High)
- Confidence: 85%
- Change: 25%
- Trend Direction: Rocket Strong upward trend (strong)
- Momentum: Accelerating

Score Factors
Velocity: 78 | Momentum: 82 | Relevance: 75 | Authority: 70 | Recency: 68

Monitor Details
- Monitor ID: india-smoking-accessories
- Terms: India smoking accessories, Finzabad glass
- Interval: week
- Data Sources: 6

Recommended Action
Red Circle Create content about India smoking accessories - high trending activity detected

Related Articles
- [Major industry development...](url)
- [Breaking: New regulations...](url)
- [Market analysis shows...](url)
```

---

## Troubleshooting

### Common Issues

**"Property does not exist" error**
- Ensure all required properties exist in your Notion database
- Property names are case-sensitive (`Coherency` not `coherency`)

**Low confidence scores**
- Add optional API keys (NewsData.io, SerpAPI) for more data sources
- Check if search terms are too specific/rare

**No articles found**
- Try broader search terms
- Some topics may not have recent coverage

**Rate limiting**
- The monitor includes built-in delays between API calls
- For heavy usage, consider longer intervals

### Getting Help

1. Run with `--dry-run` to test without making changes
2. Enable `VERBOSE=true` for detailed debugging output
3. Check the console output for specific error messages

---

## Version History

- **v2.0**: Multi-factor scoring, coherence metric, 7 data sources, action recommendations
- **v1.0**: Basic trend monitoring with Google Trends

---

*This documentation covers Notion INTEL Trend Monitor v2 with multi-factor scoring and coherence analysis.*
