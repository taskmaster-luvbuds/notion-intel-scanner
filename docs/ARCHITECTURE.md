# Notion INTEL Trend Monitor - Architecture Documentation

## Table of Contents

1. [System Overview](#system-overview)
2. [Data Flow](#data-flow)
3. [Core Components](#core-components)
4. [Scoring Algorithms](#scoring-algorithms)
5. [Source Weights](#source-weights)
6. [Data Structures](#data-structures)
7. [Extension Points](#extension-points)

---

## System Overview

The Notion INTEL Trend Monitor is an automated trend monitoring system that aggregates data from multiple sources, calculates multi-factor trend scores, and synchronizes results with Notion databases.

### High-Level Architecture

```
+-----------------------------------------------------------------------------------+
|                           NOTION INTEL TREND MONITOR v2                           |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|                              NOTION DATABASE LAYER                                |
|  +-------------------+    +-------------------+    +-------------------+          |
|  |  Monitors DB      |    |   Signals DB      |    |  Page Content     |          |
|  |  (Active Items)   |    |  (Alerts)         |    |  (Rich Blocks)    |          |
|  +-------------------+    +-------------------+    +-------------------+          |
+-----------------------------------------------------------------------------------+
                                        ^
                                        |
+-----------------------------------------------------------------------------------+
|                              ORCHESTRATION LAYER                                  |
|  +-------------------+    +-------------------+    +-------------------+          |
|  | Interval Checker  |    | Rate Limiter      |    | Error Handler     |          |
|  | (Daily/Weekly/    |    | (Exp. Backoff)    |    | (Retry Logic)     |          |
|  |  Monthly)         |    |                   |    |                   |          |
|  +-------------------+    +-------------------+    +-------------------+          |
+-----------------------------------------------------------------------------------+
                                        ^
                                        |
+-----------------------------------------------------------------------------------+
|                              SCORING ENGINE                                       |
|  +------------------+  +------------------+  +------------------+                 |
|  | Trend Score v2   |  | Coherence Score  |  | Confidence v2    |                |
|  | (6 Factors)      |  | (4 Factors)      |  | (3 Multipliers)  |                |
|  +------------------+  +------------------+  +------------------+                 |
|                                        |                                          |
|  +------------------+  +------------------+  +------------------+                 |
|  | Trend Direction  |  | Momentum Trend   |  | Action Recomm.   |                |
|  | Calculator       |  | Calculator       |  | Engine           |                |
|  +------------------+  +------------------+  +------------------+                 |
+-----------------------------------------------------------------------------------+
                                        ^
                                        |
+-----------------------------------------------------------------------------------+
|                              PROCESSING LAYER                                     |
|  +------------------+  +------------------+  +------------------+                 |
|  | Deduplication    |  | Sentiment        |  | Recency          |                |
|  | Engine           |  | Analyzer (AFINN) |  | Calculator       |                |
|  +------------------+  +------------------+  +------------------+                 |
|                                        |                                          |
|  +------------------+                                                             |
|  | EMA Smoothing    |                                                             |
|  +------------------+                                                             |
+-----------------------------------------------------------------------------------+
                                        ^
                                        |
+-----------------------------------------------------------------------------------+
|                              DATA FETCHER LAYER                                   |
|  +-------------+  +-------------+  +-------------+  +-------------+              |
|  | Google      |  | Google News |  | NewsData.io |  | SerpAPI     |              |
|  | Trends RSS  |  | RSS (FREE)  |  | (API Key)   |  | (API Key)   |              |
|  | (Multi-Geo) |  |             |  |             |  |             |              |
|  +-------------+  +-------------+  +-------------+  +-------------+              |
|                                                                                   |
|  +-------------+  +-------------+  +-------------+                               |
|  | Reddit      |  | HackerNews  |  | Additional  |                               |
|  | JSON API    |  | Algolia API |  | RSS (BBC,   |                               |
|  | (FREE)      |  | (FREE)      |  | Guardian)   |                               |
|  +-------------+  +-------------+  +-------------+                               |
+-----------------------------------------------------------------------------------+
```

### Key Design Principles

1. **Multi-Source Aggregation**: Combines 7 different data sources for comprehensive coverage
2. **Reliability-Weighted Scoring**: Each source contributes based on its reliability rating
3. **Signal Quality Metrics**: Coherence score measures agreement across sources
4. **Temporal Decay**: Recency weighting ensures fresh data has more impact
5. **Noise Reduction**: EMA smoothing prevents score volatility

---

## Data Flow

### Complete Data Flow Diagram

```
+-------------------+
|   START: Main()   |
+-------------------+
          |
          v
+-------------------+
| Fetch Active      |
| Monitors from     |
| Notion DB         |
+-------------------+
          |
          v
+-------------------+
| Filter by         |
| Interval          |
| (Daily/Weekly/    |
|  Monthly)         |
+-------------------+
          |
          v
+-------------------+     +--------------------------------------------------+
| For Each Monitor  |---->|              PARALLEL DATA FETCHING              |
+-------------------+     |                                                  |
                          |  +------------+  +------------+  +------------+  |
                          |  | Google     |  | Google     |  | NewsData   |  |
                          |  | Trends RSS |  | News RSS   |  | .io API    |  |
                          |  | (4 regions)|  |            |  |            |  |
                          |  +------------+  +------------+  +------------+  |
                          |                                                  |
                          |  +------------+  +------------+  +------------+  |
                          |  | SerpAPI    |  | Reddit     |  | HackerNews |  |
                          |  |            |  | JSON API   |  | Algolia    |  |
                          |  +------------+  +------------+  +------------+  |
                          |                                                  |
                          |  +------------+                                  |
                          |  | Additional |                                  |
                          |  | RSS Feeds  |                                  |
                          |  +------------+                                  |
                          +--------------------------------------------------+
                                        |
                                        v
                          +--------------------------------------------------+
                          |              PROCESSING PIPELINE                 |
                          |                                                  |
                          |  1. Calculate Recency Weights                    |
                          |  2. Deduplicate Articles (Jaccard Similarity)    |
                          |  3. Analyze Sentiment (AFINN)                    |
                          |  4. Calculate Coherence Score                    |
                          |  5. Calculate Trend Score v2                     |
                          |  6. Apply EMA Smoothing                          |
                          |  7. Calculate Confidence v2                      |
                          |  8. Determine Trend Direction                    |
                          |  9. Calculate Momentum Trend                     |
                          | 10. Generate Action Recommendations              |
                          +--------------------------------------------------+
                                        |
                                        v
                          +--------------------------------------------------+
                          |              OUTPUT GENERATION                   |
                          |                                                  |
                          |  +------------+  +------------+  +------------+  |
                          |  | Update     |  | Update     |  | Create     |  |
                          |  | Monitor    |  | Page       |  | Alert      |  |
                          |  | Properties |  | Content    |  | (if over   |  |
                          |  |            |  | (Blocks)   |  | threshold) |  |
                          |  +------------+  +------------+  +------------+  |
                          +--------------------------------------------------+
                                        |
                                        v
                          +-------------------+
                          |   END: Summary    |
                          +-------------------+
```

### Data Transformation Pipeline

```
Raw Data (7 Sources)
        |
        v
+------------------+
| Normalize URLs   |
| Remove Tracking  |
| Parameters       |
+------------------+
        |
        v
+------------------+
| Calculate        |
| Recency Weight   |
| (Exp. Decay)     |
+------------------+
        |
        v
+------------------+
| Deduplicate      |
| (URL + Title     |
| Similarity)      |
+------------------+
        |
        v
+------------------+
| Extract          |
| Sentiment        |
| (AFINN-111)      |
+------------------+
        |
        v
+------------------+
| Aggregate by     |
| Source Type      |
+------------------+
        |
        v
Processed Data Objects
```

---

## Core Components

### 1. Data Fetchers

#### Google Trends RSS Fetcher
- **Function**: `fetchGoogleTrendsRSS(searchTerms, regions)`
- **Endpoint**: `https://trends.google.com/trending/rss?geo={REGION}`
- **Regions**: US, GB, CA, AU (configurable via `GOOGLE_TRENDS_REGIONS`)
- **Returns**: Trending topics with traffic estimates, matching trends, region-specific data
- **Rate Limit**: 300ms between region requests

#### Google News RSS Fetcher
- **Function**: `fetchGoogleNewsRSS(searchTerms)`
- **Endpoint**: `https://news.google.com/rss/search?q={term}&hl=en-US&gl=US&ceid=US:en`
- **Returns**: Articles with titles, links, publication dates, source names
- **Rate Limit**: 300ms between term requests
- **Cost**: FREE (no API key required)

#### NewsData.io Fetcher
- **Function**: `fetchNewsVolume(searchTerms)`
- **Endpoint**: `https://newsdata.io/api/1/news`
- **Returns**: Articles with metadata, total results count
- **Rate Limit**: 500ms between requests
- **Cost**: 200 credits/day (free tier)

#### SerpAPI Google News Fetcher
- **Function**: `fetchGoogleNews(searchTerms)`
- **Endpoint**: `https://serpapi.com/search.json?engine=google_news`
- **Returns**: News results with source metadata
- **Rate Limit**: 1000ms between requests
- **Cost**: 100 searches/month (free tier)

#### Reddit JSON API Fetcher
- **Function**: `fetchRedditPosts(searchTerms)`
- **Endpoint**: `https://www.reddit.com/search.json?q={term}&sort=relevance&t=week`
- **Returns**: Posts with scores, comment counts, subreddit info
- **Rate Limit**: 500ms between requests
- **Cost**: FREE (no authentication required)

#### HackerNews Algolia Fetcher
- **Function**: `fetchHackerNews(searchTerms)`
- **Endpoint**: `https://hn.algolia.com/api/v1/search?query={term}&tags=story`
- **Returns**: Stories with points, comment counts, creation dates
- **Rate Limit**: 300ms between requests
- **Cost**: FREE (unlimited)

#### Additional RSS Fetcher (BBC, Guardian)
- **Function**: `fetchAdditionalNewsRSS(searchTerms)`
- **Endpoints**:
  - BBC: `https://feeds.bbci.co.uk/news/rss.xml`
  - Guardian: `https://www.theguardian.com/world/rss`
- **Returns**: Articles matching search terms with publication dates
- **Rate Limit**: 200ms between feeds
- **Cost**: FREE

### 2. Scoring Engine

#### Trend Score Calculator
- **Function**: `calculateTrendScoreV2(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss, monitorId)`
- **Output**: 0-100 score with factor breakdown
- **See**: [Trend Score Algorithm](#trend-score-v2-calculation)

#### Coherence Calculator
- **Function**: `calculateCoherenceScore(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss)`
- **Output**: 0-100 score with level classification (High/Medium/Low/Noise)
- **See**: [Coherence Score Algorithm](#coherence-score-calculation)

#### Confidence Calculator
- **Function**: `calculateConfidenceV2(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss, coherenceScore)`
- **Output**: 0-98% confidence with multiplier breakdown
- **See**: [Confidence Score Algorithm](#confidence-score-calculation)

### 3. Sentiment Analyzer (AFINN)

- **Module**: `sentiment.js`
- **Word List**: AFINN-111 (subset of ~200 common sentiment words)
- **Score Range**: -5 to +5 per word
- **Output**: Normalized 0-100 (50 = neutral)

#### Functions

```javascript
calculateSentiment(text)
// Tokenizes text, matches against AFINN words
// Returns: number (0-100)

calculateArticleSentiment(articles)
// Analyzes array of article titles
// Returns: { score, classification, articlesAnalyzed }
```

#### Sentiment Classifications
| Score Range | Classification |
|-------------|----------------|
| 0-30 | Negative |
| 31-45 | Somewhat Negative |
| 46-55 | Neutral |
| 56-70 | Somewhat Positive |
| 71-100 | Positive |

### 4. Deduplication Engine

- **Function**: `deduplicateArticles(articles, similarityThreshold)`
- **Default Threshold**: 0.6 (60% Jaccard similarity)

#### Algorithm
1. Normalize URLs (remove tracking parameters)
2. Check for exact URL matches
3. Calculate title similarity using Jaccard coefficient
4. Merge sources for duplicate articles
5. Return deduplicated array with merge metadata

#### URL Normalization
Removes tracking parameters: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `ref`, `source`, `fbclid`, `gclid`, `msclkid`

#### Title Similarity (Jaccard Coefficient)
```
similarity = |intersection(words1, words2)| / |union(words1, words2)|
```

### 5. Trend Direction Calculator

- **Function**: `calculateTrendDirection(currentScore, previousScore, changePercent)`

#### Direction Thresholds
| Change % | Direction | Emoji | Strength |
|----------|-----------|-------|----------|
| > 20% | up | rocket | strong |
| > 10% | up | chart_up | moderate |
| > 3% | up | arrow_up_right | weak |
| < -20% | down | chart_down | strong |
| < -10% | down | arrow_down | moderate |
| < -3% | down | arrow_down_right | weak |
| -3% to 3% | stable | arrow_right | stable |

### 6. Momentum Trend Calculator

- **Function**: `calculateMomentumTrend(regionData, articleTimestamps)`
- **Output**: `accelerating`, `steady`, or `decelerating`

#### Algorithm
1. Calculate region score (% of regions with matches)
2. Calculate recency score based on article timing:
   - Last 24h > 1.5x Last 48h = Accelerating (100)
   - Last 24h > 0.75x Last 48h = Steady (50)
   - Otherwise = Decelerating (0)
3. Combined score = 40% region + 60% recency
4. Classify: >= 70 (accelerating), >= 30 (steady), < 30 (decelerating)

### 7. Action Recommendations Engine

- **Function**: `generateActionRecommendations(trendData, coherenceData, confidenceData, monitor)`
- **Output**: Array of prioritized recommendation objects

#### Recommendation Rules

**High Priority** (Trend Score > 70 AND Coherence > 60):
- Create content about the topic
- Consider market entry
- Monitor competitor activity

**Medium Priority** (Trend Score 40-70 OR Coherence 40-60):
- Track this trend
- Research deeper
- Set up alerts

**Low Priority** (Trend Score < 40):
- Continue monitoring
- Review search terms
- Check back next cycle

**Modifiers**:
- Low confidence (< 30%): "gather more data before acting"
- High confidence (> 70%): "action recommended"
- Negative sentiment (< 40): "Caution: Negative sentiment detected"
- Positive sentiment (> 60): "favorable environment"

---

## Scoring Algorithms

### Trend Score v2 Calculation

The Trend Score uses 6 weighted factors to produce a 0-100 score.

#### Factor Weights
| Factor | Weight | Description |
|--------|--------|-------------|
| Velocity | 20% | Rate of change from previous score |
| Momentum | 20% | Sustained interest across regions |
| Relevance | 20% | Direct term matches in trending topics |
| Authority | 15% | Source credibility-weighted signal strength |
| Recency | 15% | Article freshness (exponential decay) |
| Sentiment | 10% | AFINN-based sentiment analysis |

#### Calculation Steps

```
1. RELEVANCE (0-100)
   - Count matching trends in Google Trends
   - Score = min(100, matchCount * 25)

2. AUTHORITY (0-100)
   For each source with data:
     - Calculate source score (articleCount / threshold * 100)
     - Weight by: reliability * weight * sourceScore
   Final = sum(weighted scores) / sum(weights)

3. RECENCY (0-100)
   For each source:
     - weightedCount = sum(article.recencyWeight)
     - totalCount = sum(article count)
   Score = min(100, (weightedCount / totalCount) * 100)

4. MOMENTUM (0-100)
   - Count regions with matches
   - Score = (regionsWithMatches / totalRegions) * 100

5. SENTIMENT (0-100)
   - Collect all article titles
   - Run AFINN analysis
   - Output normalized 0-100

6. VELOCITY (0-100)
   - Get previous smoothed score
   - velocity = 50 + ((current - previous) / previous) * 50
   - Clamped to 0-100

FINAL SCORE = 0.20 * velocity + 0.20 * relevance + 0.15 * authority
            + 0.15 * recency + 0.20 * momentum + 0.10 * sentiment
```

### EMA Smoothing

Exponential Moving Average prevents score volatility.

```javascript
// EMA_ALPHA = 0.3 (30% new, 70% historical)
smoothedScore = EMA_ALPHA * newScore + (1 - EMA_ALPHA) * previousScore
```

**Effect**: Score changes are dampened, requiring sustained signals to move significantly.

### Recency Weight Calculation

Articles lose influence over time using exponential decay.

```javascript
// RECENCY_HALF_LIFE_DAYS = 3
weight = 2^(-daysDiff / halfLife)
```

**Example Decay**:
| Days Old | Weight |
|----------|--------|
| 0 | 1.00 |
| 3 | 0.50 |
| 6 | 0.25 |
| 9 | 0.125 |

### Coherence Score Calculation

Measures signal agreement across sources (0-100).

#### Factor Weights
| Factor | Weight | Description |
|--------|--------|-------------|
| Direction Agreement | 30% | Do sources agree on signal presence? |
| Magnitude Consistency | 25% | Similar strength across sources? |
| Temporal Consistency | 25% | Sustained trend or spike? |
| Term Correlation | 20% | Multiple terms trending together? |

#### Calculation

```
1. DIRECTION AGREEMENT
   - Count sources with signal
   - Score = (sourcesWithSignal / totalSources) * 100

2. MAGNITUDE CONSISTENCY
   - Get magnitude from each source
   - Score = (minMagnitude / maxMagnitude) * 100

3. TEMPORAL CONSISTENCY
   - Average recency weight of matching trends
   - Score = avgRecencyWeight * 100

4. TERM CORRELATION
   - For each source, calculate term coverage
   - Score = avgTermCoverage * 100

COHERENCE = 0.30 * directionAgreement + 0.25 * magnitudeConsistency
          + 0.25 * temporalConsistency + 0.20 * termCorrelation
```

#### Coherence Levels
| Score | Level |
|-------|-------|
| >= 75 | High |
| >= 50 | Medium |
| >= 25 | Low |
| < 25 | Noise |

### Confidence Score Calculation

Measures data quality and reliability (10-98%).

#### Base Confidence
For each source with data:
```
contribution = reliability * weight
```

#### Multipliers
| Multiplier | Formula | Range |
|------------|---------|-------|
| Freshness | 0.4 + 0.6 * (dataPoints / 7) | 0.4 - 1.0 |
| Sample Size | 0.3 + 0.7 * (dataPoints / 7) | 0.3 - 1.0 |
| Agreement | 0.75 + 0.40 * (coherence / 100) | 0.75 - 1.15 |

#### Final Calculation
```
confidence = baseConfidence * freshnessMultiplier
           * sampleSizeMultiplier * agreementMultiplier

// Clamped to 10-98%, returned as percentage (0-100)
```

---

## Source Weights

### Weight Configuration

```javascript
const SOURCE_WEIGHTS = {
  googleTrends:   { reliability: 0.85, weight: 0.14 },
  googleNewsRss:  { reliability: 0.80, weight: 0.14 },
  newsData:       { reliability: 0.80, weight: 0.14 },
  serpApi:        { reliability: 0.90, weight: 0.14 },
  hackerNews:     { reliability: 0.85, weight: 0.14 },
  reddit:         { reliability: 0.70, weight: 0.10 },
  additionalRss:  { reliability: 0.80, weight: 0.20 },
};
```

### Rationale for Weights

| Source | Reliability | Weight | Rationale |
|--------|-------------|--------|-----------|
| **Google Trends** | 0.85 | 0.14 | Direct trend data from Google, highly authoritative for search interest |
| **Google News RSS** | 0.80 | 0.14 | Aggregated news from major outlets, free and reliable |
| **NewsData.io** | 0.80 | 0.14 | Quality news API with global coverage |
| **SerpAPI** | 0.90 | 0.14 | Highest reliability - structured Google data, but costs credits |
| **HackerNews** | 0.85 | 0.14 | Strong tech community signals, high engagement quality |
| **Reddit** | 0.70 | 0.10 | Broad community coverage but more noise, lower reliability |
| **Additional RSS** | 0.80 | 0.20 | BBC/Guardian are authoritative, higher weight for editorial quality |

### Why These Specific Values?

1. **Total Weight = 1.0**: Ensures normalized contribution
2. **Reddit Lower Reliability**: More user-generated content, potential spam/noise
3. **SerpAPI Highest Reliability**: Structured data directly from Google
4. **Additional RSS Higher Weight**: Editorial sources have fact-checking processes
5. **Equal Base Distribution**: Most sources get 0.14 weight for balanced input

---

## Data Structures

### Monitor Object

```javascript
{
  pageId: string,           // Notion page ID
  monitorId: string,        // Unique identifier
  terms: string[],          // Search terms array
  threshold: number,        // Alert threshold (%)
  interval: string,         // 'day' | 'week' | 'month'
  lastCheck: string | null, // ISO date of last check
  previousTrendScore: number | null,
  previousCoherence: number | null,
  previousConfidence: number | null,
}
```

### Trend Analysis Results

```javascript
{
  // Core Scores
  trendScore: number,       // 0-100 final score
  rawScore: number,         // Pre-smoothed score
  smoothedScore: number,    // EMA-smoothed score
  changePercent: number,    // % change from previous

  // Score Factors
  factors: {
    velocity: number,       // 0-100
    momentum: number,       // 0-100
    sentiment: number,      // 0-100
    relevance: number,      // 0-100
    authority: number,      // 0-100
    recency: number,        // 0-100
  },

  // Coherence
  coherenceScore: number,   // 0-100
  coherenceLevel: string,   // 'High' | 'Medium' | 'Low' | 'Noise'
  coherenceFactors: {
    directionAgreement: number,
    magnitudeConsistency: number,
    temporalConsistency: number,
    termCorrelation: number,
  },

  // Confidence
  confidence: number,       // 0-100 (displayed as %)
  confidenceFactors: {
    freshnessMultiplier: number,
    sampleSizeMultiplier: number,
    agreementMultiplier: number,
  },

  // Trend Direction
  trendDirection: {
    direction: string,      // 'up' | 'down' | 'stable'
    emoji: string,
    strength: string,       // 'strong' | 'moderate' | 'weak' | 'stable'
    description: string,
    currentScore: number,
    previousScore: number,
    changePercent: number,
  },

  // Momentum
  momentumTrend: string,    // 'accelerating' | 'steady' | 'decelerating'

  // Context Data
  articles: string,         // Formatted article list
  topArticles: string,      // Markdown-formatted top 3 articles
  sourceUrls: string,       // Newline-separated URLs
  regionsData: string,      // "US:2, GB:1, CA:0, AU:0"
  contextSummary: string,   // Human-readable summary
  dataSourcesUsed: number,  // Count of sources with data

  // Recommendations
  recommendations: string,  // Formatted recommendation text
  prioritizedRecommendations: Array<{
    priority: string,       // 'high' | 'medium' | 'low'
    text: string,
    formattedText: string,  // With emoji prefix
  }>,
  topRecommendation: string,

  // Deduplication Stats
  deduplication: {
    originalCount: number,
    deduplicatedCount: number,
  },
}
```

### Source Data Structures

#### Google Trends Result
```javascript
{
  allTrends: Array<{
    title: string,
    traffic: string,
    pubDate: Date,
    description: string,
    region: string,
    recencyWeight: number,
  }>,
  matchingTrends: Array<...>,  // Trends matching search terms
  hasMatches: boolean,
  regionData: {
    [region: string]: {
      totalTrends: number,
      matches: number,
      error?: boolean,
    }
  },
  regionsChecked: number,
}
```

#### News Source Result (Generic)
```javascript
{
  term: string,
  totalResults: number,
  weightedCount: number,    // Recency-weighted count
  articles: Array<{
    title: string,
    link: string,
    pubDate: string,
    source: string,
    recencyWeight: number,
  }>,
  error?: string,
}
```

#### Reddit Post Result
```javascript
{
  term: string,
  totalResults: number,
  weightedCount: number,
  posts: Array<{
    title: string,
    url: string,
    score: number,
    num_comments: number,
    created_utc: number,
    subreddit: string,
    recencyWeight: number,
  }>,
}
```

#### HackerNews Story Result
```javascript
{
  term: string,
  totalResults: number,
  weightedCount: number,
  stories: Array<{
    title: string,
    url: string,
    points: number,
    num_comments: number,
    created_at: string,
    recencyWeight: number,
  }>,
}
```

---

## Extension Points

### Adding a New Data Source

To add a new data source, follow these steps:

#### Step 1: Create the Fetcher Function

```javascript
/**
 * Fetch from [New Source] API
 * @param {string[]} searchTerms - Array of search terms
 * @returns {Promise<Array>} Results array
 */
async function fetchNewSource(searchTerms) {
  const results = [];

  for (const term of searchTerms.slice(0, 5)) { // Limit requests
    try {
      const url = `https://api.newsource.com/search?q=${encodeURIComponent(term)}`;

      const response = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
      });

      if (!response.ok) {
        throw new Error(`NewSource API returned ${response.status}`);
      }

      const data = await response.json();
      const items = (data.results || []).map(item => ({
        title: item.title,
        url: item.url,
        pubDate: item.published_at,
        source: 'NewSource',
        recencyWeight: calculateRecencyWeight(item.published_at),
      }));

      const weightedCount = items.reduce((sum, i) => sum + i.recencyWeight, 0);

      results.push({
        term,
        totalResults: items.length,
        weightedCount,
        items,
      });

      await sleep(300); // Rate limit
    } catch (error) {
      console.error(`  NewSource error for "${term}": ${error.message}`);
      results.push({
        term,
        totalResults: 0,
        weightedCount: 0,
        items: [],
        error: error.message,
      });
    }
  }

  return results;
}
```

#### Step 2: Add Source Weights

```javascript
const SOURCE_WEIGHTS = {
  // ... existing sources ...
  newSource: { reliability: 0.75, weight: 0.10 },
};
```

#### Step 3: Integrate into Parallel Fetch

In `analyzeMonitorTrends()`:

```javascript
const [googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss, newSource] = await Promise.all([
  fetchGoogleTrendsRSS(monitor.terms),
  fetchGoogleNewsRSS(monitor.terms),
  fetchNewsVolume(monitor.terms),
  fetchGoogleNews(monitor.terms),
  fetchRedditPosts(monitor.terms),
  fetchHackerNews(monitor.terms),
  fetchAdditionalNewsRSS(monitor.terms),
  fetchNewSource(monitor.terms),  // New source
]);
```

#### Step 4: Update Coherence Calculation

In `calculateCoherenceScore()`:

```javascript
// NewSource
if (newSource && newSource.length > 0) {
  const totalItems = newSource.reduce((sum, r) => sum + r.totalResults, 0);
  sourceSignals.push({
    source: 'newSource',
    hasSignal: totalItems > 0,
    magnitude: totalItems,
    termCoverage: newSource.filter(r => r.totalResults > 0).length / newSource.length,
  });
}
```

#### Step 5: Update Confidence Calculation

In `calculateConfidenceV2()`:

```javascript
if (newSource && newSource.length > 0) {
  const hasData = newSource.some(r => r.totalResults > 0);
  if (hasData) {
    baseConfidence += SOURCE_WEIGHTS.newSource.reliability * SOURCE_WEIGHTS.newSource.weight;
    dataPoints++;
  }
}
```

#### Step 6: Update Trend Score Calculation

In `calculateTrendScoreV2()`:

```javascript
// NewSource contribution to authority
if (newSource && newSource.length > 0) {
  const totalItems = newSource.reduce((sum, r) => sum + r.totalResults, 0);
  const nsScore = Math.min(100, (totalItems / 20) * 100);
  authorityScore += SOURCE_WEIGHTS.newSource.reliability *
    SOURCE_WEIGHTS.newSource.weight * nsScore;
  totalWeight += SOURCE_WEIGHTS.newSource.weight;

  // Collect items for article list
  for (const result of newSource) {
    for (const item of (result.items || []).slice(0, 3)) {
      if (item.title) {
        articles.push(`- ${item.title} (NewSource)`);
      }
    }
  }
}
```

#### Step 7: Update dataSourcesUsed Count

```javascript
const dataSourcesUsed =
  (googleTrends && googleTrends.allTrends?.length > 0 ? 1 : 0) +
  // ... existing sources ...
  (newSource?.length > 0 && newSource.some(r => r.totalResults > 0) ? 1 : 0);
```

### Modifying Scoring Weights

To adjust how factors contribute to the final score:

```javascript
// In calculateTrendScoreV2()
const finalScore = Math.round(
  0.20 * clampedVelocity +    // Adjust these weights
  0.20 * relevanceScore +     // Total must equal 1.0
  0.15 * authorityScore +
  0.15 * recencyScore +
  0.20 * momentumScore +
  0.10 * sentimentScore
);
```

### Adding New Recommendation Rules

In `generateActionRecommendations()`:

```javascript
// Add new condition
if (trendData.factors?.momentum > 80 && coherence > 70) {
  recommendations.push({
    priority: 'high',
    text: 'Viral potential detected - immediate action recommended',
  });
}
```

### Customizing EMA Smoothing

```javascript
// Adjust EMA_ALPHA (0.0 - 1.0)
// Lower = more smoothing (slower response)
// Higher = less smoothing (faster response)
const EMA_ALPHA = 0.3; // Default: 30% new, 70% historical
```

### Customizing Recency Decay

```javascript
// Adjust half-life in days
// Lower = faster decay (favors very recent articles)
// Higher = slower decay (older articles retain more weight)
const RECENCY_HALF_LIFE_DAYS = 3; // Default: 3 days
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NOTION_TOKEN` | Yes | Notion API integration token |
| `MONITORS_DATABASE_ID` | Yes | Notion database ID for trend monitors |
| `SIGNALS_DATABASE_ID` | No | Notion database ID for alerts |
| `NEWSDATA_API_KEY` | No | NewsData.io API key (free: 200 credits/day) |
| `SERPAPI_KEY` | No | SerpAPI key (free: 100 searches/month) |
| `DRY_RUN` | No | Set to 'true' to test without updates |
| `VERBOSE` | No | Set to 'true' for detailed factor logs |

---

## Constants Reference

```javascript
const FETCH_TIMEOUT_MS = 10000;          // Request timeout
const MAX_CONTENT_LENGTH = 1900;         // Notion content limit
const EMA_ALPHA = 0.3;                   // EMA smoothing factor
const RECENCY_HALF_LIFE_DAYS = 3;        // Recency decay rate
const GOOGLE_TRENDS_REGIONS = ['US', 'GB', 'CA', 'AU'];
```

---

*Document generated from trend-monitor.js v2 codebase analysis*
