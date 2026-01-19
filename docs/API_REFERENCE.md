# API Reference

This document provides comprehensive documentation for all functions in the Notion INTEL Trend Monitor system.

## Table of Contents

1. [Data Fetching Functions](#data-fetching-functions)
2. [Scoring Functions](#scoring-functions)
3. [Analysis Functions](#analysis-functions)
4. [Utility Functions](#utility-functions)
5. [Recommendation Functions](#recommendation-functions)
6. [Constants and Configuration](#constants-and-configuration)

---

## Data Fetching Functions

These functions retrieve trend and news data from various external sources.

### fetchGoogleTrendsRSS(terms, regions)

Fetches daily trending searches from Google Trends RSS feed across multiple regions.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `terms` | `string[]` | Required | Array of search terms to match against trending topics |
| `regions` | `string[]` | `['US', 'GB', 'CA', 'AU']` | Array of region codes for multi-region fetching |

**Returns:**

```javascript
{
  allTrends: Array<{
    title: string,
    traffic: string,
    pubDate: Date,
    description: string,
    region: string,
    recencyWeight: number
  }>,
  matchingTrends: Array<Object>,  // Trends matching search terms
  hasMatches: boolean,            // Whether any matches were found
  regionData: {
    [regionCode: string]: {
      totalTrends: number,
      matches: number,
      error?: boolean
    }
  },
  regionsChecked: number
}
```

**Description:**

Queries Google Trends RSS feed for each specified region. Searches for term matches in both title and description of trending topics. Applies recency weighting to each trend based on publication date. Rate limits requests with 300ms delay between regions.

**Usage Example:**

```javascript
const results = await fetchGoogleTrendsRSS(['AI', 'machine learning'], ['US', 'GB']);

console.log(results.hasMatches);           // true/false
console.log(results.matchingTrends.length); // Number of matching trends
console.log(results.regionData.US.matches); // Matches in US region
```

---

### fetchGoogleNewsRSS(terms)

Fetches news articles from Google News RSS search feed.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `terms` | `string[]` | Required | Array of search terms (limited to first 5 terms) |

**Returns:**

```javascript
Array<{
  term: string,
  totalResults: number,
  weightedCount: number,        // Recency-weighted article count
  articles: Array<{
    title: string,
    link: string,
    pubDate: string,
    source: string,
    recencyWeight: number
  }>,
  error?: string                // Present if fetch failed
}>
```

**Description:**

Queries Google News RSS search endpoint for each term. Extracts source name from article title (Google News format: "Title - Source"). Returns up to 10 articles per term. Rate limits with 300ms delay between terms.

**Usage Example:**

```javascript
const newsResults = await fetchGoogleNewsRSS(['cryptocurrency', 'bitcoin']);

for (const result of newsResults) {
  console.log(`${result.term}: ${result.totalResults} articles`);
  for (const article of result.articles) {
    console.log(`  - ${article.title} (${article.source})`);
  }
}
```

---

### fetchNewsVolume(terms)

Fetches news articles from NewsData.io API.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `terms` | `string[]` | Required | Array of search terms (limited to first 5 terms) |

**Returns:**

```javascript
Array<{
  term: string,
  totalResults: number,
  weightedCount: number,
  articles: Array<{
    title: string,
    source: string,
    pubDate: string,
    link: string | null,
    recencyWeight: number
  }>
}> | null  // Returns null if NEWSDATA_API_KEY not set
```

**Description:**

Requires `NEWSDATA_API_KEY` environment variable. Returns up to 5 articles per term. Validates URLs before including them. Free tier limited to 200 credits/day. Rate limits with 500ms delay between terms.

**Usage Example:**

```javascript
const newsData = await fetchNewsVolume(['tech startups']);

if (newsData) {
  const totalArticles = newsData.reduce((sum, r) => sum + r.totalResults, 0);
  console.log(`Found ${totalArticles} total articles`);
}
```

---

### fetchGoogleNews(terms)

Fetches Google News results via SerpAPI.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `terms` | `string[]` | Required | Array of search terms (limited to first 3 terms) |

**Returns:**

```javascript
Array<{
  term: string,
  newsResults: Array<{
    title: string,
    link: string,
    source: Object,
    date: string,
    recencyWeight: number
  }>,
  totalResults: number,
  weightedCount: number
}> | null  // Returns null if SERPAPI_KEY not set
```

**Description:**

Requires `SERPAPI_KEY` environment variable. Free tier limited to 100 searches/month. Conservative term limit (3) to preserve API quota. Rate limits with 1000ms delay between terms.

**Usage Example:**

```javascript
const serpResults = await fetchGoogleNews(['electric vehicles']);

if (serpResults) {
  for (const result of serpResults) {
    console.log(`${result.term}: ${result.totalResults} news items`);
  }
}
```

---

### fetchRedditPosts(terms)

Fetches Reddit posts via public JSON API.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `terms` | `string[]` | Required | Array of search terms (limited to first 5 terms) |

**Returns:**

```javascript
Array<{
  term: string,
  totalResults: number,
  weightedCount: number,        // Engagement-weighted count
  posts: Array<{
    title: string,
    url: string,
    score: number,
    num_comments: number,
    created_utc: number,
    subreddit: string,
    recencyWeight: number
  }>,
  error?: string
}>
```

**Description:**

Uses Reddit's public JSON API (no authentication required). Searches for relevance-sorted posts from the past week. Applies engagement multiplier (score + comments) to weighted count. Returns up to 10 posts per term. Rate limits with 500ms delay between terms.

**Usage Example:**

```javascript
const redditPosts = await fetchRedditPosts(['gaming news']);

for (const result of redditPosts) {
  for (const post of result.posts) {
    console.log(`r/${post.subreddit}: ${post.title} (${post.score} pts)`);
  }
}
```

---

### fetchHackerNews(terms)

Fetches HackerNews stories via Algolia API.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `terms` | `string[]` | Required | Array of search terms (limited to first 5 terms) |

**Returns:**

```javascript
Array<{
  term: string,
  totalResults: number,
  weightedCount: number,        // Engagement-weighted count
  stories: Array<{
    title: string,
    url: string,
    points: number,
    num_comments: number,
    created_at: string,
    recencyWeight: number
  }>,
  error?: string
}>
```

**Description:**

Uses HackerNews Algolia API (free, unlimited, no auth required). Searches for story-tagged items only. Applies engagement multiplier (points + comments) to weighted count. Returns up to 10 stories per term. Rate limits with 300ms delay between terms.

**Usage Example:**

```javascript
const hnStories = await fetchHackerNews(['rust programming']);

for (const result of hnStories) {
  for (const story of result.stories) {
    console.log(`${story.title} - ${story.points} points`);
  }
}
```

---

### fetchAdditionalNewsRSS(terms)

Fetches news from BBC and The Guardian RSS feeds.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `terms` | `string[]` | Required | Array of search terms to filter articles |

**Returns:**

```javascript
{
  allMatchingArticles: Array<{
    title: string,
    link: string,
    pubDate: string,
    source: string,           // 'BBC News' or 'The Guardian'
    description: string,
    recencyWeight: number
  }>,
  totalMatches: number,
  weightedCount: number
}
```

**Description:**

Fetches full RSS feeds from BBC News and The Guardian World sections. Filters articles locally for term matches in title or description. No API key required. Rate limits with 200ms delay between feeds.

**Usage Example:**

```javascript
const additionalNews = await fetchAdditionalNewsRSS(['climate change']);

console.log(`Found ${additionalNews.totalMatches} matching articles`);
for (const article of additionalNews.allMatchingArticles) {
  console.log(`[${article.source}] ${article.title}`);
}
```

---

## Scoring Functions

These functions calculate various scores to assess trend strength and reliability.

### calculateTrendScoreV2(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss, monitorId)

Calculates the multi-factor trend score (0-100).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `googleTrends` | `Object` | Results from `fetchGoogleTrendsRSS()` |
| `googleNewsRss` | `Array` | Results from `fetchGoogleNewsRSS()` |
| `newsData` | `Array\|null` | Results from `fetchNewsVolume()` |
| `serpResults` | `Array\|null` | Results from `fetchGoogleNews()` |
| `reddit` | `Array` | Results from `fetchRedditPosts()` |
| `hackerNews` | `Array` | Results from `fetchHackerNews()` |
| `additionalRss` | `Object` | Results from `fetchAdditionalNewsRSS()` |
| `monitorId` | `string` | Unique identifier for EMA smoothing history |

**Returns:**

```javascript
{
  trendScore: number,           // Final score (0-100)
  rawScore: number,             // Score before EMA smoothing
  smoothedScore: number,        // EMA-smoothed score
  changePercent: number,        // % change from previous score
  articles: string,             // Newline-separated article summaries
  dataSourcesUsed: number,      // Count of sources with data
  factors: {
    velocity: number,           // Rate of change (0-100)
    momentum: number,           // Sustained interest (0-100)
    sentiment: number,          // AFINN sentiment (0-100, 50=neutral)
    relevance: number,          // Term match quality (0-100)
    authority: number,          // Source credibility weighted (0-100)
    recency: number             // Article freshness (0-100)
  }
}
```

**Description:**

Calculates a composite trend score using 6 weighted factors:
- **Velocity (20%)**: Rate of change from previous score
- **Momentum (20%)**: Regional consistency in Google Trends
- **Sentiment (10%)**: AFINN-based sentiment analysis of article titles
- **Relevance (20%)**: Direct term matches in trending topics
- **Authority (15%)**: Source credibility-weighted scores
- **Recency (15%)**: Freshness of articles with exponential decay

Applies EMA smoothing to reduce noise and provide stable scores over time.

**Usage Example:**

```javascript
const trendScore = calculateTrendScoreV2(
  googleTrends, googleNewsRss, newsData, serpResults,
  reddit, hackerNews, additionalRss, 'monitor-123'
);

console.log(`Trend Score: ${trendScore.trendScore}/100`);
console.log(`Factors: V=${trendScore.factors.velocity} M=${trendScore.factors.momentum}`);
```

---

### calculateCoherenceScore(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss)

Calculates signal reliability/coherence score (0-100).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `googleTrends` | `Object` | Results from `fetchGoogleTrendsRSS()` |
| `googleNewsRss` | `Array` | Results from `fetchGoogleNewsRSS()` |
| `newsData` | `Array\|null` | Results from `fetchNewsVolume()` |
| `serpResults` | `Array\|null` | Results from `fetchGoogleNews()` |
| `reddit` | `Array` | Results from `fetchRedditPosts()` |
| `hackerNews` | `Array` | Results from `fetchHackerNews()` |
| `additionalRss` | `Object` | Results from `fetchAdditionalNewsRSS()` |

**Returns:**

```javascript
{
  coherenceScore: number,       // 0-100
  coherenceLevel: string,       // 'High', 'Medium', 'Low', or 'Noise'
  factors: {
    directionAgreement: number,     // Do sources agree on signal presence?
    magnitudeConsistency: number,   // Similar strength across sources?
    temporalConsistency: number,    // Sustained vs spike?
    termCorrelation: number         // Multiple terms trending together?
  }
}
```

**Description:**

Measures how reliably the trend signal is confirmed across multiple sources:
- **Direction Agreement (30%)**: Percentage of sources showing a signal
- **Magnitude Consistency (25%)**: Min/max ratio of signal strengths
- **Temporal Consistency (25%)**: Average recency weight of matching trends
- **Term Correlation (20%)**: Coverage of search terms across sources

Coherence levels:
- High: >= 75
- Medium: >= 50
- Low: >= 25
- Noise: < 25

**Usage Example:**

```javascript
const coherence = calculateCoherenceScore(
  googleTrends, googleNewsRss, newsData, serpResults,
  reddit, hackerNews, additionalRss
);

if (coherence.coherenceLevel === 'High') {
  console.log('Strong signal agreement across sources');
}
```

---

### calculateConfidenceV2(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss, coherenceScore)

Calculates confidence score with source weighting and multipliers.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `googleTrends` | `Object` | Results from `fetchGoogleTrendsRSS()` |
| `googleNewsRss` | `Array` | Results from `fetchGoogleNewsRSS()` |
| `newsData` | `Array\|null` | Results from `fetchNewsVolume()` |
| `serpResults` | `Array\|null` | Results from `fetchGoogleNews()` |
| `reddit` | `Array` | Results from `fetchRedditPosts()` |
| `hackerNews` | `Array` | Results from `fetchHackerNews()` |
| `additionalRss` | `Object` | Results from `fetchAdditionalNewsRSS()` |
| `coherenceScore` | `number` | Coherence score (0-100) |

**Returns:**

```javascript
{
  confidence: number,           // 10-98 (as percentage)
  dataPoints: number,           // Number of sources with data
  factors: {
    freshnessMultiplier: number,    // 0.4-1.0
    sampleSizeMultiplier: number,   // 0.3-1.0
    agreementMultiplier: number     // 0.75-1.15
  }
}
```

**Description:**

Calculates confidence based on:
- Source count and individual reliability weights
- Data freshness (more sources = higher freshness multiplier)
- Sample size (data points / max possible sources)
- Source agreement (boosted by coherence score)

Maximum of 7 possible data sources. Returns confidence as percentage (0-100) for Notion display.

**Usage Example:**

```javascript
const confidence = calculateConfidenceV2(
  googleTrends, googleNewsRss, newsData, serpResults,
  reddit, hackerNews, additionalRss, 75
);

console.log(`Confidence: ${confidence.confidence}%`);
console.log(`Based on ${confidence.dataPoints} data sources`);
```

---

### calculateRecencyWeight(pubDate)

Calculates exponential decay weight based on article age.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `pubDate` | `string\|Date` | Publication date of the article |

**Returns:**

`number` - Weight between 0 and 1 (1 = brand new, decays over time)

**Description:**

Uses exponential decay formula: `weight = 2^(-daysDiff / halfLife)`

Half-life is 3 days by default (configurable via `RECENCY_HALF_LIFE_DAYS`). Returns 0.5 for unknown/invalid dates.

**Usage Example:**

```javascript
const today = new Date();
const threeDaysAgo = new Date(today - 3 * 24 * 60 * 60 * 1000);

console.log(calculateRecencyWeight(today));         // ~1.0
console.log(calculateRecencyWeight(threeDaysAgo));  // ~0.5
console.log(calculateRecencyWeight(null));          // 0.5 (default)
```

---

## Analysis Functions

These functions analyze trends, sentiment, and direction.

### calculateSentiment(text)

Calculates sentiment score for a text string using AFINN-111 word list.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `text` | `string` | Text to analyze |

**Returns:**

`number` - Normalized score 0-100 (50 = neutral)

**Description:**

Tokenizes text, matches against ~200 common AFINN words with scores from -5 to +5. Normalizes using formula: `50 + (totalScore / wordCount) * 10`. Returns 50 for empty text or no sentiment words found.

**Sentiment Scale:**
- 0-30: Negative
- 31-45: Somewhat Negative
- 46-55: Neutral
- 56-70: Somewhat Positive
- 71-100: Positive

**Usage Example:**

```javascript
const { calculateSentiment } = require('./sentiment');

console.log(calculateSentiment('This is amazing news!'));      // ~65
console.log(calculateSentiment('Terrible disaster strikes'));  // ~35
console.log(calculateSentiment('The meeting is tomorrow'));    // 50
```

---

### calculateArticleSentiment(articles)

Calculates average sentiment across multiple articles.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `articles` | `Array<{title: string}>` | Array of article objects with title property |

**Returns:**

```javascript
{
  score: number,              // Average sentiment (0-100)
  classification: string,     // 'Positive', 'Somewhat Positive', 'Neutral', 'Somewhat Negative', 'Negative'
  articlesAnalyzed: number    // Count of articles with titles
}
```

**Description:**

Iterates through articles, extracts titles (or `name` property as fallback), calculates individual sentiment scores, and returns the average with classification.

**Usage Example:**

```javascript
const { calculateArticleSentiment } = require('./sentiment');

const articles = [
  { title: 'Company reports record profits' },
  { title: 'New breakthrough in technology' },
  { title: 'Market concerns grow amid uncertainty' }
];

const sentiment = calculateArticleSentiment(articles);
console.log(`Sentiment: ${sentiment.classification} (${sentiment.score})`);
```

---

### calculateTrendDirection(currentScore, previousScore, changePercent)

Determines trend direction based on score change.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `currentScore` | `number` | Current trend score |
| `previousScore` | `number` | Previous trend score |
| `changePercent` | `number` | Percentage change |

**Returns:**

```javascript
{
  direction: string,      // 'up', 'down', or 'stable'
  emoji: string,          // Visual indicator
  strength: string,       // 'strong', 'moderate', 'weak', or 'stable'
  description: string,    // Human-readable description
  currentScore: number,
  previousScore: number,
  changePercent: number
}
```

**Description:**

Thresholds:
- Strong up: > 20% change
- Moderate up: > 10% change
- Weak up: > 3% change
- Stable: -3% to +3% change
- Weak down: < -3% change
- Moderate down: < -10% change
- Strong down: < -20% change

**Usage Example:**

```javascript
const direction = calculateTrendDirection(75, 50, 50);

console.log(direction.emoji);       // '🚀'
console.log(direction.description); // 'Strong upward trend'
console.log(direction.strength);    // 'strong'
```

---

### calculateMomentumTrend(regionData, articleTimestamps)

Calculates momentum based on regional consistency and article timing.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `regionData` | `Object` | Region data from Google Trends with matches per region |
| `articleTimestamps` | `Array<string>` | Array of article publication timestamps |

**Returns:**

`string` - One of: `'accelerating'`, `'steady'`, or `'decelerating'`

**Description:**

Combines two factors:
- **Region Score (40%)**: Percentage of regions with matches
- **Recency Score (60%)**: Compares articles in last 24h vs 24-48h

Returns:
- `accelerating`: Combined score >= 70
- `steady`: Combined score >= 30
- `decelerating`: Combined score < 30

**Usage Example:**

```javascript
const regionData = { US: { matches: 2 }, GB: { matches: 1 }, CA: { matches: 0 }, AU: { matches: 1 } };
const timestamps = [
  new Date().toISOString(),
  new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
  new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
];

const momentum = calculateMomentumTrend(regionData, timestamps);
console.log(`Momentum: ${momentum}`); // e.g., 'accelerating'
```

---

## Utility Functions

### deduplicateArticles(articles, threshold)

Removes duplicate articles based on URL and title similarity.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `articles` | `Array` | Required | Array of article objects |
| `threshold` | `number` | `0.6` | Similarity threshold (0-1) for title matching |

**Returns:**

```javascript
{
  articles: Array<Object>,      // Deduplicated articles with merged sources
  originalCount: number,        // Count before deduplication
  deduplicatedCount: number     // Count after deduplication
}
```

**Description:**

Two-phase deduplication:
1. **URL-based**: Normalizes URLs (removes tracking params) and groups exact matches
2. **Title-based**: Uses Jaccard similarity to find near-duplicate titles

Merges source information when duplicates are found.

**Usage Example:**

```javascript
const articles = [
  { title: 'Breaking News Story', link: 'https://example.com/story?utm_source=twitter', source: 'Twitter' },
  { title: 'Breaking News Story', link: 'https://example.com/story?utm_source=facebook', source: 'Facebook' },
  { title: 'Breaking News Story Update', link: 'https://other.com/story', source: 'Other' }
];

const result = deduplicateArticles(articles, 0.6);
console.log(`${result.originalCount} -> ${result.deduplicatedCount}`); // "3 -> 2"
```

---

### normalizeUrl(url)

Normalizes URL for comparison by removing tracking parameters.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | `string` | URL to normalize |

**Returns:**

`string` - Normalized lowercase URL without tracking parameters

**Description:**

Removes common tracking parameters:
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`
- `ref`, `source`, `fbclid`, `gclid`, `msclkid`

Returns lowercase original string if URL parsing fails.

**Usage Example:**

```javascript
const url1 = 'https://Example.com/article?utm_source=twitter&id=123';
const url2 = 'https://example.com/article?utm_source=facebook&id=123';

console.log(normalizeUrl(url1)); // 'https://example.com/article?id=123'
console.log(normalizeUrl(url1) === normalizeUrl(url2)); // true
```

---

### calculateTitleSimilarity(title1, title2)

Calculates Jaccard similarity coefficient between two titles.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `title1` | `string` | First title |
| `title2` | `string` | Second title |

**Returns:**

`number` - Similarity score 0-1 (1 = identical, 0 = no overlap)

**Description:**

Process:
1. Lowercase both titles
2. Remove non-alphanumeric characters
3. Split into words (>2 characters)
4. Calculate Jaccard coefficient: `|intersection| / |union|`

**Usage Example:**

```javascript
const sim1 = calculateTitleSimilarity(
  'Apple announces new iPhone release',
  'Apple reveals new iPhone launch'
);
console.log(sim1); // ~0.5

const sim2 = calculateTitleSimilarity(
  'Weather forecast for tomorrow',
  'Stock market update today'
);
console.log(sim2); // ~0.0
```

---

### applyEMASmoothing(score, monitorId)

Applies Exponential Moving Average smoothing to scores.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `score` | `number` | New raw score |
| `monitorId` | `string` | Unique identifier for history tracking |

**Returns:**

`number` - EMA-smoothed score

**Description:**

Formula: `newSmoothed = alpha * newValue + (1 - alpha) * previousSmoothed`

Default alpha (EMA_ALPHA) is 0.3, meaning:
- 30% weight to new value
- 70% weight to historical average

Returns raw score on first observation. Maintains in-memory history per monitor.

**Usage Example:**

```javascript
// First call
console.log(applyEMASmoothing(80, 'monitor-1')); // 80 (no history)

// Second call
console.log(applyEMASmoothing(60, 'monitor-1')); // 66 (0.3*60 + 0.7*80)

// Third call
console.log(applyEMASmoothing(70, 'monitor-1')); // 67 (0.3*70 + 0.7*66)
```

---

## Recommendation Functions

### generateActionRecommendations(trendData, coherenceData, confidenceData, monitor)

Generates action recommendations based on trend analysis.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `trendData` | `Object` | Object with `trendScore` and `factors` (including sentiment) |
| `coherenceData` | `Object` | Object with `coherenceScore` and `coherenceLevel` |
| `confidenceData` | `Object` | Object with `confidence` percentage |
| `monitor` | `Object` | Monitor object with `terms` array |

**Returns:**

```javascript
Array<{
  priority: string,       // 'high', 'medium', or 'low'
  text: string,           // Recommendation text
  isModifier?: boolean    // True if this modifies other recommendations
}>
```

**Description:**

Generates recommendations based on score combinations:

**High Priority** (trendScore > 70 AND coherence > 60):
- Create content about the topic
- Consider market entry
- Monitor competitor activity

**Medium Priority** (trendScore 40-70 OR coherence 40-60):
- Track this trend
- Research deeper
- Set up alerts

**Low Priority** (trendScore < 40):
- Continue monitoring
- Review search terms
- Check back next cycle

Also adds modifiers based on confidence and sentiment levels.

**Usage Example:**

```javascript
const recommendations = generateActionRecommendations(
  { trendScore: 75, factors: { sentiment: 65 } },
  { coherenceScore: 70, coherenceLevel: 'Medium' },
  { confidence: 80 },
  { terms: ['AI trends'] }
);

for (const rec of recommendations) {
  console.log(`[${rec.priority.toUpperCase()}] ${rec.text}`);
}
```

---

### prioritizeRecommendations(recommendations)

Sorts and formats recommendations by priority.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `recommendations` | `Array` | Array of recommendation objects from `generateActionRecommendations()` |

**Returns:**

```javascript
Array<{
  priority: string,
  text: string,
  formattedText: string    // Text with priority emoji prefix
}>
```

**Description:**

- Sorts by priority order: high -> medium -> low
- Adds emoji indicators: high, medium, low
- Limits output to top 3 recommendations

**Usage Example:**

```javascript
const recommendations = generateActionRecommendations(trendData, coherenceData, confidenceData, monitor);
const prioritized = prioritizeRecommendations(recommendations);

for (const rec of prioritized) {
  console.log(rec.formattedText);
  // Example output:
  // "Create content about AI trends - high trending activity detected"
}
```

---

## Constants and Configuration

### Source Weights

```javascript
const SOURCE_WEIGHTS = {
  googleTrends:    { reliability: 0.85, weight: 0.14 },
  googleNewsRss:   { reliability: 0.80, weight: 0.14 },
  newsData:        { reliability: 0.80, weight: 0.14 },
  serpApi:         { reliability: 0.90, weight: 0.14 },
  hackerNews:      { reliability: 0.85, weight: 0.14 },
  reddit:          { reliability: 0.70, weight: 0.10 },
  additionalRss:   { reliability: 0.80, weight: 0.20 }
};
```

### Configuration Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `FETCH_TIMEOUT_MS` | `10000` | Request timeout in milliseconds |
| `MAX_CONTENT_LENGTH` | `1900` | Max characters for Notion rich text |
| `GOOGLE_TRENDS_REGIONS` | `['US', 'GB', 'CA', 'AU']` | Regions for multi-region trends |
| `EMA_ALPHA` | `0.3` | EMA smoothing factor |
| `RECENCY_HALF_LIFE_DAYS` | `3` | Days for recency weight half-life |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NOTION_TOKEN` | Yes | Notion API integration token |
| `MONITORS_DATABASE_ID` | Yes | Notion database ID for trend monitors |
| `SIGNALS_DATABASE_ID` | No | Notion database ID for alerts |
| `NEWSDATA_API_KEY` | No | NewsData.io API key (200 credits/day free) |
| `SERPAPI_KEY` | No | SerpAPI key (100 searches/month free) |
| `DRY_RUN` | No | Set to 'true' to test without updating Notion |
| `VERBOSE` | No | Set to 'true' for detailed factor breakdowns |

---

## Data Source Summary

| Source | Free? | Rate Limit | API Key Required |
|--------|-------|------------|------------------|
| Google Trends RSS | Yes | 300ms delay | No |
| Google News RSS | Yes | 300ms delay | No |
| NewsData.io | 200/day | 500ms delay | Yes |
| SerpAPI | 100/month | 1000ms delay | Yes |
| Reddit JSON | Yes | 500ms delay | No |
| HackerNews Algolia | Yes | 300ms delay | No |
| BBC/Guardian RSS | Yes | 200ms delay | No |
