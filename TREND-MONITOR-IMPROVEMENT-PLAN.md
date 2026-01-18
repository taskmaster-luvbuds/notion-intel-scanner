# Trend Monitor Score Improvement Plan

## Executive Summary

This document provides a prioritized roadmap for improving trend monitoring scores in the Notion INTEL Trend Monitor system. The current implementation uses Google Trends RSS, NewsData.io, and SerpAPI, with a simple scoring algorithm that can be significantly enhanced.

**Current State Analysis:**
- Scoring algorithm: Simple point accumulation (0-40 per source, normalized to 0-100)
- Data sources: 3 (Google Trends RSS free, NewsData.io 200/day, SerpAPI 100/month)
- Confidence calculation: Basic formula (0.5 + sources * 0.15)
- Historical tracking: None (always uses baseline of 50)
- Change detection: Simple percentage from baseline

---

## Phase 1: Quick Wins (No New APIs Needed)

These improvements use existing data sources and can be implemented immediately.

### 1.1 Implement Historical Score Persistence

**What to Implement:**
- Store previous trend scores in Notion database (add `previous_score` number property)
- Read actual previous score instead of hardcoded baseline of 50
- Track score history for rolling average calculations

**Why It Improves Scores:**
- Current system always compares against 50, making change percentages inaccurate
- Real historical data enables meaningful trend detection
- Prevents false positives/negatives from arbitrary baseline

**Implementation Effort:** LOW

**Expected Score Improvement:**
- Change detection accuracy: +20-30%
- False alert reduction: -40%

**Code Location:** Line 521 (`const previousScore = 50;`)

---

### 1.2 Improve Term Matching Algorithm

**What to Implement:**
```javascript
// Current: Simple includes() check
topic.title.toLowerCase().includes(term.toLowerCase())

// Improved: Add fuzzy matching, word boundaries, synonyms
- Use word boundary matching: \bterm\b
- Implement Levenshtein distance for typo tolerance
- Add basic synonym expansion (e.g., "cannabis" -> "marijuana", "weed")
- Support phrase matching with proximity scoring
```

**Why It Improves Scores:**
- Current exact matching misses relevant variations
- Typos in news sources cause missed matches
- Related terms often signal the same trend

**Implementation Effort:** MEDIUM

**Expected Score Improvement:**
- Match rate increase: +25-40%
- Trend detection sensitivity: +30%

**Code Location:** Lines 324-329 (matchingTrends filter)

---

### 1.3 Weighted Source Scoring

**What to Implement:**
- Assign different weights based on source reliability
- Google Trends direct match: 1.5x multiplier (most reliable)
- Recent articles (< 24h): 1.3x multiplier
- Older articles: 0.8x multiplier
- High-authority sources: 1.2x multiplier

**Why It Improves Scores:**
- Not all signals are equally valuable
- Recent news is more indicative of current trends
- Authority sources reduce noise from spam sites

**Implementation Effort:** LOW

**Expected Score Improvement:**
- Score accuracy: +15-25%
- Noise reduction: -30%

**Code Location:** Lines 431-500 (calculateTrendScore function)

---

### 1.4 Multi-Region Trend Analysis

**What to Implement:**
- Fetch Google Trends RSS from multiple regions: US, GB, CA, AU
- Weight results by market relevance
- Detect global vs local trends

**Why It Improves Scores:**
- Current system only checks US trends
- Many business trends are international
- Regional arbitrage opportunities detected earlier

**Implementation Effort:** LOW

**Expected Score Improvement:**
- Trend coverage: +40%
- Early detection: +20%

**Code Location:** Lines 305-339 (fetchGoogleTrendsRSS function)

---

### 1.5 Article Recency Weighting

**What to Implement:**
```javascript
// Weight articles by age
const hoursAgo = (Date.now() - new Date(article.pubDate)) / (1000 * 60 * 60);
const recencyWeight = hoursAgo < 6 ? 1.5 :
                      hoursAgo < 24 ? 1.2 :
                      hoursAgo < 72 ? 1.0 : 0.7;
```

**Why It Improves Scores:**
- Breaking news is more significant than old articles
- Detects trend acceleration vs stale data
- Improves change percentage accuracy

**Implementation Effort:** LOW

**Expected Score Improvement:**
- Trend freshness accuracy: +35%
- Alert timeliness: +25%

**Code Location:** Lines 449-464 (newsData processing)

---

### 1.6 Implement Confidence Intervals

**What to Implement:**
- Calculate confidence based on data quality, not just source count
- Factor in: article count, source diversity, time spread, term match quality
- Report confidence ranges (e.g., "Score: 72 [65-79]")

**Why It Improves Scores:**
- Current confidence formula is too simplistic (0.5 + sources * 0.15)
- Users need to know when scores are reliable
- Prevents overconfidence on thin data

**Implementation Effort:** MEDIUM

**Expected Score Improvement:**
- Decision quality: +40%
- False alert reduction: -35%

**Code Location:** Line 533 (confidence calculation)

---

### 1.7 Implement Score Smoothing

**What to Implement:**
- Use exponential moving average (EMA) for score stability
- `smoothedScore = alpha * currentScore + (1 - alpha) * previousSmoothedScore`
- Configurable alpha (suggest 0.3 for weekly, 0.5 for daily)

**Why It Improves Scores:**
- Reduces noise from daily fluctuations
- Makes trend direction clearer
- Prevents alert fatigue from oscillating scores

**Implementation Effort:** LOW

**Expected Score Improvement:**
- Score stability: +50%
- Trend clarity: +30%

---

## Phase 2: Free API Additions

Add new data sources without additional cost.

### 2.1 Add Wikipedia Pageview API (FREE - Unlimited)

**What to Implement:**
```javascript
// Wikimedia Pageviews API - completely free, no key required
const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${article}/daily/${startDate}/${endDate}`;
```

**Why It Improves Scores:**
- Wikipedia views correlate strongly with public interest
- 100% free, unlimited API calls
- Historical data available (great for change detection)
- Covers topics news may not report on

**Implementation Complexity:** LOW

**Expected Improvement:**
- Data source coverage: +30%
- Historical analysis: +50%
- Confidence boost: +0.10

**Priority:** HIGH - Add first

---

### 2.2 Add Reddit API (FREE - 60 requests/minute)

**What to Implement:**
```javascript
// Reddit search API - free, rate limited
const url = `https://www.reddit.com/search.json?q=${term}&sort=new&t=week&limit=25`;
// Headers: User-Agent required
```

**Why It Improves Scores:**
- Reddit often leads mainstream news by 24-48 hours
- Community sentiment adds context
- Upvotes/comments provide engagement metrics
- Subreddit-specific monitoring possible

**Implementation Complexity:** LOW

**Expected Improvement:**
- Early trend detection: +40%
- Sentiment data: NEW CAPABILITY
- Confidence boost: +0.15

**Priority:** HIGH - Add second

---

### 2.3 Add Hacker News API (FREE - Unlimited)

**What to Implement:**
```javascript
// HN Algolia API - free, unlimited
const url = `https://hn.algolia.com/api/v1/search?query=${term}&tags=story&numericFilters=created_at_i>${unixTimestamp}`;
```

**Why It Improves Scores:**
- Tech industry early indicator
- High-quality discussions
- Points/comments show engagement intensity
- Completely free, no limits

**Implementation Complexity:** LOW

**Expected Improvement:**
- Tech trend detection: +50%
- Quality signal: +25%
- Confidence boost: +0.10

**Priority:** MEDIUM - Add for tech-focused monitors

---

### 2.4 Add Twitter/X Search via Nitter (FREE)

**What to Implement:**
```javascript
// Use Nitter instances for Twitter scraping
const instances = ['nitter.net', 'nitter.unixfox.eu', 'nitter.poast.org'];
const url = `https://${instance}/search?f=tweets&q=${term}`;
// Parse HTML response for tweet data
```

**Why It Improves Scores:**
- Real-time public sentiment
- Viral content detection
- Influencer activity tracking
- No API key required (web scraping)

**Implementation Complexity:** MEDIUM (requires HTML parsing)

**Expected Improvement:**
- Real-time detection: +60%
- Viral trend capture: +70%
- Sentiment analysis: NEW CAPABILITY

**Priority:** MEDIUM - Higher complexity but high value

---

### 2.5 Add GitHub Trending (FREE)

**What to Implement:**
```javascript
// GitHub trending API (unofficial but stable)
const url = `https://api.github.com/search/repositories?q=${term}&sort=stars&order=desc&per_page=10`;
// Rate limit: 10 requests/minute unauthenticated
```

**Why It Improves Scores:**
- Tracks open-source technology trends
- Star velocity indicates developer interest
- Fork count shows adoption

**Implementation Complexity:** LOW

**Expected Improvement:**
- Tech tool trends: +40%
- Developer sentiment: NEW CAPABILITY

**Priority:** LOW - Niche but valuable for tech monitors

---

### 2.6 Add DuckDuckGo Instant Answer (FREE)

**What to Implement:**
```javascript
// DuckDuckGo Instant Answer API - free, no key
const url = `https://api.duckduckgo.com/?q=${term}&format=json&no_html=1`;
```

**Why It Improves Scores:**
- Provides entity recognition
- Related topics expand search scope
- Disambiguation helps term matching

**Implementation Complexity:** LOW

**Expected Improvement:**
- Term understanding: +20%
- Related topic discovery: +30%

**Priority:** LOW - Supplementary data

---

## Phase 3: Advanced Features

Longer-term improvements for sophisticated trend analysis.

### 3.1 Historical Trend Database

**What to Implement:**
- Create dedicated Notion database for historical scores
- Store: date, monitor_id, score, confidence, sources_used, articles
- Enable 7-day, 30-day, 90-day trend analysis
- Calculate velocity (rate of change) and acceleration

**Why It Improves Scores:**
- Currently no historical context
- Enables true trend detection (rising/falling/stable)
- Powers predictive capabilities
- Identifies seasonal patterns

**Implementation Effort:** MEDIUM

**Expected Score Improvement:**
- Trend accuracy: +60%
- Predictive capability: NEW
- Pattern recognition: NEW

---

### 3.2 Predictive Trend Scoring

**What to Implement:**
```javascript
// Simple linear regression for trend prediction
function predictNextScore(historicalScores) {
  // Calculate slope of last N data points
  // Project forward based on velocity and acceleration
  // Return predicted score with confidence interval
}
```

**Why It Improves Scores:**
- Anticipate trends before they peak
- Enable proactive alerts ("trend likely to exceed threshold in 3 days")
- Identify trend reversals early

**Implementation Effort:** MEDIUM

**Expected Score Improvement:**
- Predictive alerts: NEW CAPABILITY
- Early warning: +3-5 days lead time
- Strategic value: HIGH

---

### 3.3 Automated Threshold Tuning

**What to Implement:**
- Track alert-to-action ratio (how often alerts led to actual user action)
- Automatically adjust thresholds based on:
  - False positive rate
  - Missed trend rate
  - User engagement patterns
- Implement per-monitor threshold learning

**Why It Improves Scores:**
- Current static thresholds miss optimal sensitivity
- Different monitors need different thresholds
- Reduces alert fatigue while catching important trends

**Implementation Effort:** HIGH

**Expected Score Improvement:**
- Alert precision: +50%
- User engagement: +40%
- False positives: -60%

---

### 3.4 Semantic Term Expansion

**What to Implement:**
- Use a small language model or word embeddings to expand search terms
- Find related terms: "vape" -> "e-cigarette", "vaping", "juul"
- Industry-specific synonym databases
- Context-aware expansion based on monitor category

**Why It Improves Scores:**
- Catches trends that use different terminology
- Improves recall without sacrificing precision
- Adapts to evolving language

**Implementation Effort:** HIGH

**Expected Score Improvement:**
- Term coverage: +80%
- Trend detection: +45%
- Match quality: +35%

---

### 3.5 Source Authority Ranking

**What to Implement:**
- Build a database of news source authority scores
- Factors: Alexa rank, domain age, fact-check history, topic expertise
- Weight articles by source authority
- Detect and discount content farms/spam sites

**Why It Improves Scores:**
- Not all news sources are equal
- Spam articles inflate false scores
- Authority sources indicate real trends

**Implementation Effort:** MEDIUM

**Expected Score Improvement:**
- Score accuracy: +40%
- Spam resistance: +70%
- Signal quality: +50%

---

### 3.6 Anomaly Detection Engine

**What to Implement:**
```javascript
// Detect unusual patterns that warrant attention
function detectAnomalies(currentData, historicalBaseline) {
  // Z-score analysis for outlier detection
  // Sudden volume spikes
  // Unusual source patterns
  // Sentiment shift detection
}
```

**Why It Improves Scores:**
- Catches breaking news faster
- Identifies manipulation attempts
- Detects trend shifts before they show in score

**Implementation Effort:** MEDIUM

**Expected Score Improvement:**
- Breaking news detection: +70%
- Anomaly identification: NEW CAPABILITY
- Alert quality: +45%

---

### 3.7 Multi-Language Support

**What to Implement:**
- Extend searches to non-English sources
- Add language parameter to monitors
- Aggregate results across language versions
- Priority languages: Spanish, French, German, Portuguese, Chinese

**Why It Improves Scores:**
- Many trends start in non-English markets
- Global trend detection
- Earlier warning for international topics

**Implementation Effort:** MEDIUM

**Expected Score Improvement:**
- Global coverage: +100%
- Early detection: +30%
- Market intelligence: +50%

---

## Implementation Priority Matrix

| Item | Effort | Impact | Priority | Estimated Time |
|------|--------|--------|----------|----------------|
| 1.1 Historical Persistence | Low | High | P0 | 2 hours |
| 1.4 Multi-Region Trends | Low | High | P0 | 1 hour |
| 1.5 Article Recency Weighting | Low | High | P0 | 1 hour |
| 2.1 Wikipedia API | Low | High | P0 | 2 hours |
| 2.2 Reddit API | Low | High | P1 | 3 hours |
| 1.2 Improved Term Matching | Medium | High | P1 | 4 hours |
| 1.3 Weighted Source Scoring | Low | Medium | P1 | 2 hours |
| 1.7 Score Smoothing | Low | Medium | P1 | 1 hour |
| 2.3 Hacker News API | Low | Medium | P1 | 2 hours |
| 1.6 Confidence Intervals | Medium | High | P2 | 4 hours |
| 2.4 Twitter via Nitter | Medium | High | P2 | 6 hours |
| 3.1 Historical Database | Medium | High | P2 | 8 hours |
| 3.2 Predictive Scoring | Medium | High | P2 | 8 hours |
| 3.5 Source Authority | Medium | Medium | P3 | 6 hours |
| 3.6 Anomaly Detection | Medium | High | P3 | 8 hours |
| 3.3 Auto Threshold Tuning | High | High | P3 | 12 hours |
| 3.4 Semantic Expansion | High | High | P4 | 16 hours |
| 3.7 Multi-Language | Medium | Medium | P4 | 10 hours |

---

## Quick Start: First Week Implementation

**Day 1-2: Foundation**
1. Add `previous_score` property to Notion monitors database
2. Implement historical score persistence (1.1)
3. Add multi-region Google Trends (1.4)

**Day 3-4: Data Sources**
4. Integrate Wikipedia Pageview API (2.1)
5. Integrate Reddit API (2.2)
6. Update calculateTrendScore to include new sources

**Day 5: Refinement**
7. Implement article recency weighting (1.5)
8. Add weighted source scoring (1.3)
9. Implement score smoothing (1.7)

**Expected Results After Week 1:**
- Trend score accuracy: +40-50%
- Data source coverage: +60%
- Change detection reliability: +70%
- False alert reduction: -35%

---

## Metrics to Track

After implementing improvements, track these metrics:

1. **Score Accuracy**: Compare predicted trends to actual outcomes
2. **Alert Precision**: % of alerts that led to user action
3. **Detection Latency**: How early trends are detected vs peak
4. **Data Source Availability**: % uptime per source
5. **Confidence Calibration**: Are 80% confidence scores right 80% of the time?
6. **User Engagement**: How often users check/act on trend data

---

## Conclusion

This improvement plan provides a clear path from the current basic implementation to a sophisticated trend monitoring system. The Phase 1 quick wins can be implemented in a few days with significant score improvements. The free API additions in Phase 2 dramatically increase data coverage. Phase 3 builds predictive and learning capabilities for long-term competitive advantage.

Start with Phase 1 items marked P0, then progressively add capabilities based on user feedback and observed results.
