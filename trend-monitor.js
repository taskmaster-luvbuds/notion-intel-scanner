#!/usr/bin/env node
/**
 * Notion INTEL Trend Monitor v2
 *
 * Automated trend monitoring system with multi-factor scoring:
 * 1. Reads active monitors from Notion database
 * 2. Performs trend analysis using multiple data sources (multi-region)
 * 3. Calculates Trend Score v2 (6 factors: velocity, momentum, sentiment, relevance, authority, recency)
 * 4. Calculates Coherence Score (signal reliability: 0-100)
 * 5. Calculates Confidence v2 (source-weighted with multipliers)
 * 6. Creates alerts when thresholds are exceeded
 *
 * Scoring Features:
 * - Multi-region Google Trends (US, GB, CA, AU)
 * - Article recency weighting (exponential decay)
 * - Source reliability weights
 * - EMA score smoothing
 * - Coherence metric for signal quality
 *
 * Data Sources (Free Tier):
 * - Google Trends RSS (daily trending searches - free, no API key)
 * - NewsData.io (200 credits/day free)
 * - Google News via SerpAPI (100 searches/month free, if configured)
 *
 * Required environment variables:
 *   NOTION_TOKEN - Notion API integration token
 *   MONITORS_DATABASE_ID - Notion database ID for trend monitors
 *
 * Optional:
 *   SIGNALS_DATABASE_ID - Notion database ID for signals (for alerts)
 *   NEWSDATA_API_KEY - NewsData.io API key (free tier: 200 credits/day)
 *   SERPAPI_KEY - SerpAPI key for Google News (100 free searches/month)
 *   DRY_RUN - Set to 'true' to test without updating Notion
 *   VERBOSE - Set to 'true' for detailed factor breakdowns
 */

const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');

// Initialize Notion client
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Configuration
const MONITORS_DB = process.env.MONITORS_DATABASE_ID;
const SIGNALS_DB = process.env.SIGNALS_DATABASE_ID;
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

// Constants
const FETCH_TIMEOUT_MS = 10000;
const MAX_CONTENT_LENGTH = 1900;

// Source Reliability Weights (Phase 1)
const SOURCE_WEIGHTS = {
  googleTrends: { reliability: 0.85, weight: 0.35 },
  newsData: { reliability: 0.80, weight: 0.35 },
  serpApi: { reliability: 0.90, weight: 0.30 },
};

// Multi-region configuration for Google Trends
const GOOGLE_TRENDS_REGIONS = ['US', 'GB', 'CA', 'AU'];

// Score history storage (in-memory for now, persists per run)
const scoreHistory = new Map();

// EMA smoothing factor (0.3 = 30% new, 70% historical)
const EMA_ALPHA = 0.3;

// Recency decay constants
const RECENCY_HALF_LIFE_DAYS = 3; // Articles lose half their weight every 3 days

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validate URL format
 */
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Calculate recency weight using exponential decay
 * Articles lose half their weight every RECENCY_HALF_LIFE_DAYS
 */
function calculateRecencyWeight(pubDate) {
  if (!pubDate) return 0.5; // Default weight for unknown dates

  const articleDate = new Date(pubDate);
  const now = new Date();
  const daysDiff = (now - articleDate) / (1000 * 60 * 60 * 24);

  // Exponential decay: weight = 2^(-daysDiff / halfLife)
  return Math.pow(2, -daysDiff / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Apply EMA smoothing to a score
 * newSmoothed = alpha * newValue + (1 - alpha) * previousSmoothed
 */
function applyEMASmoothing(newScore, monitorId) {
  const previousScore = scoreHistory.get(monitorId);

  if (previousScore === undefined) {
    // First observation, return as-is
    scoreHistory.set(monitorId, newScore);
    return newScore;
  }

  const smoothedScore = Math.round(EMA_ALPHA * newScore + (1 - EMA_ALPHA) * previousScore);
  scoreHistory.set(monitorId, smoothedScore);
  return smoothedScore;
}

/**
 * Get previous score for a monitor from history
 */
function getPreviousScore(monitorId) {
  return scoreHistory.get(monitorId) || null;
}

/**
 * Fetch with timeout to prevent hanging requests
 */
async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw error;
  }
}

/**
 * Wrapper for Notion API calls with exponential backoff
 */
async function notionRequest(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.code === 'rate_limited' || error.status === 429) {
        const delay = Math.pow(2, i) * 1000;
        console.log(`  Rate limited, waiting ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}

/**
 * Parse monitor terms from rich text
 * Handles comma-separated terms like "India smoking accessories, Finzabad glass"
 */
function parseTerms(termsText) {
  if (!termsText) return [];
  return termsText
    .split(',')
    .map(term => term.trim())
    .filter(term => term.length > 0);
}

// ============================================================================
// NOTION DATABASE OPERATIONS
// ============================================================================

/**
 * Fetch all active monitors from the Notion database
 */
async function fetchActiveMonitors() {
  const monitors = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const response = await notionRequest(() => notion.databases.query({
      database_id: MONITORS_DB,
      filter: {
        property: 'active',
        checkbox: { equals: true }
      },
      start_cursor: startCursor,
    }));

    for (const page of response.results) {
      const props = page.properties;

      // Extract properties safely
      const monitorId = props.monitor_id?.title?.[0]?.plain_text || page.id;
      const terms = props.terms?.rich_text?.[0]?.plain_text || '';
      const threshold = props.threshold?.number || 20;
      const interval = props.interval?.select?.name || 'week';
      const lastCheck = props.last_check?.date?.start || null;

      // Read existing scores for historical tracking
      const previousTrendScore = props.trend_score?.number || null;
      const previousCoherence = props.Coherency?.number || props.coherence?.number || null;
      const previousConfidence = props.confidence?.number || null;

      // Pre-populate score history if we have previous scores
      if (previousTrendScore !== null) {
        scoreHistory.set(monitorId, previousTrendScore);
      }

      monitors.push({
        pageId: page.id,
        monitorId,
        terms: parseTerms(terms),
        threshold,
        interval,
        lastCheck,
        previousTrendScore,
        previousCoherence,
        previousConfidence,
      });
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }

  return monitors;
}

/**
 * Update monitor in Notion with trend results
 * Writes: last_check, trend_score, coherence, confidence
 */
async function updateMonitor(pageId, results) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update monitor ${pageId} with:`);
    console.log(`    - trend_score: ${results.trendScore}`);
    console.log(`    - coherence: ${results.coherenceScore}`);
    console.log(`    - confidence: ${results.confidence}`);
    return true;
  }

  try {
    const properties = {
      'last_check': { date: { start: new Date().toISOString().split('T')[0] } },
    };

    // Add score properties if they exist in results
    // Note: Property names must match exactly what's in Notion database
    if (results.trendScore !== undefined) {
      properties['trend_score'] = { number: results.trendScore };
    }
    if (results.coherenceScore !== undefined) {
      // Try both "coherence" and "Coherency" (Notion property names are case-sensitive)
      properties['Coherency'] = { number: results.coherenceScore };
    }
    if (results.confidence !== undefined) {
      properties['confidence'] = { number: results.confidence };
    }
    // Also store change percentage for historical tracking
    if (results.changePercent !== undefined) {
      properties['change_percent'] = { number: results.changePercent };
    }

    await notionRequest(() => notion.pages.update({
      page_id: pageId,
      properties,
    }));
    return true;
  } catch (error) {
    // If property doesn't exist, log warning with details
    if (error.message?.includes('property does not exist') || error.code === 'validation_error') {
      console.error(`  Warning: Some score properties may not exist in your Notion database.`);
      console.error(`  Please add these Number properties to your Trend Monitors database:`);
      console.error(`    - trend_score (Number) - stores the calculated trend score 0-100`);
      console.error(`    - Coherency (Number) - stores the coherence score 0-100`);
      console.error(`    - confidence (Number) - stores the confidence 0.0-1.0`);
      console.error(`    - change_percent (Number) - stores the % change from previous`);
      console.error(`  Error: ${error.message}`);
    } else {
      console.error(`  Warning: Error updating monitor: ${error.message}`);
    }
    return false;
  }
}

/**
 * Check if alert already exists for this monitor today
 */
async function alertExistsToday(monitorId) {
  if (!SIGNALS_DB) return false;

  const today = new Date().toISOString().split('T')[0];

  try {
    const response = await notionRequest(() => notion.databases.query({
      database_id: SIGNALS_DB,
      filter: {
        and: [
          { property: 'source', rich_text: { contains: monitorId } },
          { property: 'timestamp', date: { equals: today } },
          { property: 'signal_type', select: { equals: 'TREND' } },
        ]
      },
      page_size: 1
    }));
    return response.results.length > 0;
  } catch (error) {
    console.error(`  Warning: Error checking for duplicate alert: ${error.message}`);
    return true; // Conservative: skip rather than create duplicate
  }
}

/**
 * Create alert signal when threshold is exceeded (v2 with coherence)
 */
async function createAlert(monitor, trendData) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would create alert for ${monitor.monitorId}`);
    return true;
  }

  try {
    const alertId = `trend-alert-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const articlesContent = (trendData.articles || 'No related articles found').substring(0, MAX_CONTENT_LENGTH);

    // Determine alert emoji based on coherence level
    const coherenceEmoji = trendData.coherenceLevel === 'High' ? '🎯' :
      trendData.coherenceLevel === 'Medium' ? '📊' : '⚡';

    await notionRequest(() => notion.pages.create({
      parent: { database_id: SIGNALS_DB },
      icon: { type: 'emoji', emoji: '📈' },
      properties: {
        'signal_id': { title: [{ text: { content: alertId } }] },
        'entity': { rich_text: [{ text: { content: monitor.terms.join(', ').substring(0, 100) } }] },
        'signal_type': { select: { name: 'TREND' } },
        'content': { rich_text: [{ text: { content: `Trend alert: ${trendData.summary}`.substring(0, 200) } }] },
        'source': { rich_text: [{ text: { content: `Monitor: ${monitor.monitorId}` } }] },
        'confidence': { number: trendData.confidence || 0.8 },
        'timestamp': { date: { start: new Date().toISOString().split('T')[0] } },
        'processed': { checkbox: false },
      },
      children: [
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: '📈 Trend Alert' } }] }
        },
        {
          type: 'callout',
          callout: {
            icon: { type: 'emoji', emoji: '⚠️' },
            rich_text: [{ text: { content: `Threshold exceeded: ${trendData.changePercent}% change (threshold: ${monitor.threshold}%)` } }]
          }
        },
        {
          type: 'heading_3',
          heading_3: { rich_text: [{ text: { content: 'Scoring Metrics' } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Trend Score: ${trendData.trendScore} (raw: ${trendData.rawScore || trendData.trendScore})` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `${coherenceEmoji} Coherence: ${trendData.coherenceScore || 'N/A'} (${trendData.coherenceLevel || 'Unknown'})` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Confidence: ${(trendData.confidence * 100).toFixed(0)}%` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Change: ${trendData.changePercent}%` } }] }
        },
        {
          type: 'heading_3',
          heading_3: { rich_text: [{ text: { content: 'Score Factors' } }] }
        },
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: trendData.factors ?
            `Velocity: ${trendData.factors.velocity} | Momentum: ${trendData.factors.momentum} | Relevance: ${trendData.factors.relevance} | Authority: ${trendData.factors.authority} | Recency: ${trendData.factors.recency}` :
            'Factor breakdown not available' } }] }
        },
        {
          type: 'heading_3',
          heading_3: { rich_text: [{ text: { content: 'Monitor Details' } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Monitor ID: ${monitor.monitorId}` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Terms: ${monitor.terms.join(', ')}` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Interval: ${monitor.interval}` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Data Sources: ${trendData.dataSourcesUsed}` } }] }
        },
        {
          type: 'heading_3',
          heading_3: { rich_text: [{ text: { content: 'Related Articles' } }] }
        },
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: articlesContent } }] }
        },
      ]
    }));
    return true;
  } catch (error) {
    console.error(`  Warning: Error creating alert: ${error.message}`);
    return false;
  }
}

// ============================================================================
// TREND DATA SOURCES
// ============================================================================

/**
 * Fetch Google Trends daily trending searches via RSS feed (FREE - no API key required)
 * Now supports multi-region fetching for better global coverage
 */
async function fetchGoogleTrendsRSS(searchTerms, regions = GOOGLE_TRENDS_REGIONS) {
  const parser = new Parser({
    timeout: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
  });

  const allResults = {
    allTrends: [],
    matchingTrends: [],
    hasMatches: false,
    regionData: {},
  };

  for (const geo of regions) {
    try {
      const url = `https://trends.google.com/trending/rss?geo=${geo}`;
      const feed = await parser.parseURL(url);

      const trendingTopics = feed.items.map(item => ({
        title: item.title,
        traffic: item['ht:approx_traffic'] || 'N/A',
        pubDate: new Date(item.pubDate),
        description: item.contentSnippet || '',
        region: geo,
        recencyWeight: calculateRecencyWeight(item.pubDate),
      }));

      // Check if any of our search terms appear in trending topics
      const matchingTrends = trendingTopics.filter(topic =>
        searchTerms.some(term =>
          topic.title.toLowerCase().includes(term.toLowerCase()) ||
          topic.description.toLowerCase().includes(term.toLowerCase())
        )
      );

      // Aggregate results
      allResults.allTrends.push(...trendingTopics);
      allResults.matchingTrends.push(...matchingTrends);
      allResults.regionData[geo] = {
        totalTrends: trendingTopics.length,
        matches: matchingTrends.length,
      };

      await sleep(300); // Rate limit between regions
    } catch (error) {
      console.error(`  Warning: Google Trends RSS error for ${geo}: ${error.message}`);
      allResults.regionData[geo] = { totalTrends: 0, matches: 0, error: true };
    }
  }

  allResults.hasMatches = allResults.matchingTrends.length > 0;
  allResults.regionsChecked = regions.length;

  return allResults;
}

/**
 * Fetch news volume from NewsData.io (FREE tier: 200 credits/day)
 * Now includes recency weighting for articles
 */
async function fetchNewsVolume(searchTerms) {
  if (!process.env.NEWSDATA_API_KEY) {
    return null;
  }

  const results = [];

  for (const term of searchTerms.slice(0, 5)) { // Limit to conserve credits
    try {
      const encodedTerm = encodeURIComponent(term);
      const url = `https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_API_KEY}&q=${encodedTerm}&language=en`;

      const response = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
      });

      if (!response.ok) {
        throw new Error(`NewsData.io returned ${response.status}`);
      }

      const data = await response.json();
      const articles = (data.results || []).slice(0, 5).map(a => ({
        title: a.title,
        source: a.source_id,
        pubDate: a.pubDate,
        link: isValidUrl(a.link) ? a.link : null,
        recencyWeight: calculateRecencyWeight(a.pubDate),
      }));

      // Calculate weighted article count (recent articles count more)
      const weightedCount = articles.reduce((sum, a) => sum + a.recencyWeight, 0);

      results.push({
        term,
        totalResults: data.totalResults || 0,
        weightedCount,
        articles,
      });

      await sleep(500); // Rate limit
    } catch (error) {
      console.error(`  NewsData.io error for "${term}": ${error.message}`);
    }
  }

  return results;
}

/**
 * Fetch Google News via SerpAPI (FREE tier: 100 searches/month)
 * Now includes recency weighting
 */
async function fetchGoogleNews(searchTerms) {
  if (!process.env.SERPAPI_KEY) {
    return null;
  }

  const results = [];

  for (const term of searchTerms.slice(0, 3)) { // Conservative limit
    try {
      const url = `https://serpapi.com/search.json?engine=google_news&q=${encodeURIComponent(term)}&api_key=${process.env.SERPAPI_KEY}`;
      const response = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
      });

      if (!response.ok) {
        throw new Error(`SerpAPI returned ${response.status}`);
      }

      const data = await response.json();
      const newsResults = (data.news_results || []).map(n => ({
        ...n,
        recencyWeight: calculateRecencyWeight(n.date),
      }));

      // Calculate weighted count
      const weightedCount = newsResults.reduce((sum, n) => sum + n.recencyWeight, 0);

      results.push({
        term,
        newsResults,
        totalResults: newsResults.length,
        weightedCount,
      });

      await sleep(1000); // Rate limit
    } catch (error) {
      console.error(`  SerpAPI error for "${term}": ${error.message}`);
    }
  }

  return results;
}

/**
 * Calculate Coherence Score - measures signal agreement across sources
 * Range: 0-100 (higher = more reliable signal)
 *
 * Factors:
 * - Direction Agreement (30%): Do sources agree on trend direction?
 * - Magnitude Consistency (25%): Similar signal strength across sources?
 * - Temporal Consistency (25%): Sustained trend or spike?
 * - Term Correlation (20%): Related terms trending together?
 */
function calculateCoherenceScore(googleTrends, newsData, serpResults) {
  let directionAgreement = 0;
  let magnitudeConsistency = 0;
  let temporalConsistency = 0;
  let termCorrelation = 0;

  const sourceSignals = [];

  // Collect signals from each source
  if (googleTrends && googleTrends.hasMatches !== undefined) {
    sourceSignals.push({
      source: 'googleTrends',
      hasSignal: googleTrends.hasMatches,
      magnitude: googleTrends.matchingTrends?.length || 0,
      regionAgreement: Object.values(googleTrends.regionData || {})
        .filter(r => r.matches > 0).length,
    });
  }

  if (newsData && newsData.length > 0) {
    const totalArticles = newsData.reduce((sum, r) => sum + r.totalResults, 0);
    sourceSignals.push({
      source: 'newsData',
      hasSignal: totalArticles > 0,
      magnitude: totalArticles,
      termCoverage: newsData.filter(r => r.totalResults > 0).length / newsData.length,
    });
  }

  if (serpResults && serpResults.length > 0) {
    const totalNews = serpResults.reduce((sum, r) => sum + r.totalResults, 0);
    sourceSignals.push({
      source: 'serpApi',
      hasSignal: totalNews > 0,
      magnitude: totalNews,
      termCoverage: serpResults.filter(r => r.totalResults > 0).length / serpResults.length,
    });
  }

  if (sourceSignals.length === 0) {
    return { coherenceScore: 0, coherenceLevel: 'Noise', factors: {} };
  }

  // Direction Agreement: Do sources agree on presence of signal?
  const sourcesWithSignal = sourceSignals.filter(s => s.hasSignal).length;
  directionAgreement = sourceSignals.length > 0
    ? (sourcesWithSignal / sourceSignals.length) * 100
    : 0;

  // Magnitude Consistency: Normalize and compare magnitudes
  if (sourceSignals.length >= 2) {
    const magnitudes = sourceSignals.map(s => s.magnitude);
    const maxMag = Math.max(...magnitudes);
    const minMag = Math.min(...magnitudes);
    // Consistency is high when min/max ratio is close to 1
    magnitudeConsistency = maxMag > 0 ? (minMag / maxMag) * 100 : 0;
  } else {
    magnitudeConsistency = 50; // Default for single source
  }

  // Temporal Consistency: Check if trends are recent and sustained
  if (googleTrends && googleTrends.matchingTrends?.length > 0) {
    const avgRecency = googleTrends.matchingTrends.reduce(
      (sum, t) => sum + (t.recencyWeight || 0.5), 0
    ) / googleTrends.matchingTrends.length;
    temporalConsistency = avgRecency * 100;
  } else {
    temporalConsistency = 50; // Default
  }

  // Term Correlation: Check if multiple terms are showing signal
  const termCoverages = sourceSignals
    .filter(s => s.termCoverage !== undefined)
    .map(s => s.termCoverage);
  if (termCoverages.length > 0) {
    termCorrelation = (termCoverages.reduce((a, b) => a + b, 0) / termCoverages.length) * 100;
  } else if (googleTrends && googleTrends.regionData) {
    // Use region agreement as proxy
    const regionsWithMatches = Object.values(googleTrends.regionData).filter(r => r.matches > 0).length;
    termCorrelation = (regionsWithMatches / GOOGLE_TRENDS_REGIONS.length) * 100;
  } else {
    termCorrelation = 50;
  }

  // Calculate weighted coherence score
  const coherenceScore = Math.round(
    0.30 * directionAgreement +
    0.25 * magnitudeConsistency +
    0.25 * temporalConsistency +
    0.20 * termCorrelation
  );

  // Determine coherence level
  let coherenceLevel;
  if (coherenceScore >= 75) coherenceLevel = 'High';
  else if (coherenceScore >= 50) coherenceLevel = 'Medium';
  else if (coherenceScore >= 25) coherenceLevel = 'Low';
  else coherenceLevel = 'Noise';

  return {
    coherenceScore: Math.min(100, Math.max(0, coherenceScore)),
    coherenceLevel,
    factors: {
      directionAgreement: Math.round(directionAgreement),
      magnitudeConsistency: Math.round(magnitudeConsistency),
      temporalConsistency: Math.round(temporalConsistency),
      termCorrelation: Math.round(termCorrelation),
    },
  };
}

/**
 * Calculate Confidence Score v2
 * Range: 0.10 - 0.98
 *
 * Factors:
 * - Source count and reliability weights
 * - Data freshness
 * - Sample size
 * - Source agreement
 */
function calculateConfidenceV2(googleTrends, newsData, serpResults, coherenceScore) {
  let baseConfidence = 0;
  let dataPoints = 0;

  // Calculate weighted source contributions
  if (googleTrends && googleTrends.allTrends?.length > 0) {
    baseConfidence += SOURCE_WEIGHTS.googleTrends.reliability * SOURCE_WEIGHTS.googleTrends.weight;
    dataPoints++;
  }

  if (newsData && newsData.length > 0) {
    const hasData = newsData.some(r => r.totalResults > 0);
    if (hasData) {
      baseConfidence += SOURCE_WEIGHTS.newsData.reliability * SOURCE_WEIGHTS.newsData.weight;
      dataPoints++;
    }
  }

  if (serpResults && serpResults.length > 0) {
    const hasData = serpResults.some(r => r.totalResults > 0);
    if (hasData) {
      baseConfidence += SOURCE_WEIGHTS.serpApi.reliability * SOURCE_WEIGHTS.serpApi.weight;
      dataPoints++;
    }
  }

  // Apply multipliers
  const freshnessMultiplier = 0.4 + (0.6 * (dataPoints / 3)); // 0.4 - 1.0
  const sampleSizeMultiplier = 0.3 + (0.7 * Math.min(1, dataPoints / 3)); // 0.3 - 1.0
  const agreementMultiplier = 0.75 + (0.40 * (coherenceScore / 100)); // 0.75 - 1.15

  let confidence = baseConfidence * freshnessMultiplier * sampleSizeMultiplier * agreementMultiplier;

  // Clamp to valid range
  confidence = Math.min(0.98, Math.max(0.10, confidence));

  return {
    confidence: Math.round(confidence * 100) / 100,
    dataPoints,
    factors: {
      freshnessMultiplier: Math.round(freshnessMultiplier * 100) / 100,
      sampleSizeMultiplier: Math.round(sampleSizeMultiplier * 100) / 100,
      agreementMultiplier: Math.round(agreementMultiplier * 100) / 100,
    },
  };
}

/**
 * Calculate Trend Score v2 - Multi-factor scoring
 * Range: 0-100
 *
 * Factors (weights):
 * - Velocity (20%): Rate of change from previous
 * - Momentum (20%): Sustained interest indicator
 * - Sentiment (10%): Positive vs negative (basic)
 * - Relevance (20%): Term match quality
 * - Authority (15%): Source credibility weighted
 * - Recency (15%): Article freshness weighted
 */
function calculateTrendScoreV2(googleTrends, newsData, serpResults, monitorId) {
  let articles = [];

  // Get previous score from history (or use baseline)
  const previousScore = getPreviousScore(monitorId) || 50;

  // === Factor 1: Relevance (20%) - Term match quality ===
  let relevanceScore = 0;
  if (googleTrends && googleTrends.hasMatches) {
    // Direct matches in trending topics = high relevance
    relevanceScore = Math.min(100, googleTrends.matchingTrends.length * 25);
  }

  // === Factor 2: Authority (15%) - Source credibility weighted ===
  let authorityScore = 0;
  let totalWeight = 0;

  if (googleTrends && googleTrends.allTrends?.length > 0) {
    authorityScore += SOURCE_WEIGHTS.googleTrends.reliability *
      SOURCE_WEIGHTS.googleTrends.weight * (googleTrends.hasMatches ? 100 : 20);
    totalWeight += SOURCE_WEIGHTS.googleTrends.weight;
  }

  if (newsData && newsData.length > 0) {
    const totalArticles = newsData.reduce((sum, r) => sum + r.totalResults, 0);
    const newsScore = Math.min(100, (totalArticles / 50) * 100);
    authorityScore += SOURCE_WEIGHTS.newsData.reliability *
      SOURCE_WEIGHTS.newsData.weight * newsScore;
    totalWeight += SOURCE_WEIGHTS.newsData.weight;

    // Collect article summaries
    for (const result of newsData) {
      for (const article of result.articles || []) {
        if (article.title) {
          articles.push(`- ${article.title} (${article.source || 'Unknown'})`);
        }
      }
    }
  }

  if (serpResults && serpResults.length > 0) {
    const totalNews = serpResults.reduce((sum, r) => sum + r.totalResults, 0);
    const serpScore = Math.min(100, (totalNews / 30) * 100);
    authorityScore += SOURCE_WEIGHTS.serpApi.reliability *
      SOURCE_WEIGHTS.serpApi.weight * serpScore;
    totalWeight += SOURCE_WEIGHTS.serpApi.weight;

    // Collect article summaries
    for (const result of serpResults) {
      for (const news of (result.newsResults || []).slice(0, 3)) {
        if (news.title) {
          articles.push(`- ${news.title} (${news.source?.name || 'Unknown'})`);
        }
      }
    }
  }

  authorityScore = totalWeight > 0 ? authorityScore / totalWeight : 0;

  // === Factor 3: Recency (15%) - Article freshness weighted ===
  let recencyScore = 50; // Default baseline

  if (newsData && newsData.length > 0) {
    const totalWeighted = newsData.reduce((sum, r) => sum + (r.weightedCount || 0), 0);
    const totalRaw = newsData.reduce((sum, r) => sum + r.totalResults, 0);
    if (totalRaw > 0) {
      recencyScore = Math.min(100, (totalWeighted / totalRaw) * 100);
    }
  }

  if (serpResults && serpResults.length > 0) {
    const totalWeighted = serpResults.reduce((sum, r) => sum + (r.weightedCount || 0), 0);
    const totalRaw = serpResults.reduce((sum, r) => sum + r.totalResults, 0);
    if (totalRaw > 0) {
      const serpRecency = Math.min(100, (totalWeighted / totalRaw) * 100);
      recencyScore = (recencyScore + serpRecency) / 2;
    }
  }

  // === Factor 4: Momentum (20%) - Sustained interest ===
  let momentumScore = 50; // Baseline

  if (googleTrends && googleTrends.regionData) {
    // More regions with matches = higher momentum
    const regionsWithMatches = Object.values(googleTrends.regionData)
      .filter(r => r.matches > 0).length;
    momentumScore = (regionsWithMatches / GOOGLE_TRENDS_REGIONS.length) * 100;
  }

  // === Factor 5: Velocity (20%) - Rate of change ===
  // Will be calculated after we have the raw score

  // === Factor 6: Sentiment (10%) - Basic sentiment (placeholder) ===
  // For now, use neutral baseline. Can be enhanced with VADER later.
  const sentimentScore = 50;

  // Calculate raw trend score (without velocity)
  const rawScore = Math.round(
    0.20 * relevanceScore +    // Relevance (will add velocity weight here)
    0.15 * authorityScore +    // Authority
    0.15 * recencyScore +      // Recency
    0.20 * momentumScore +     // Momentum
    0.10 * sentimentScore +    // Sentiment
    0.20 * 50                  // Velocity placeholder (50 = no change)
  );

  // Apply EMA smoothing
  const smoothedScore = applyEMASmoothing(rawScore, monitorId);

  // Now calculate velocity based on smoothed score
  const velocityScore = previousScore > 0
    ? 50 + ((smoothedScore - previousScore) / previousScore) * 50
    : 50;
  const clampedVelocity = Math.min(100, Math.max(0, velocityScore));

  // Final score with velocity factor applied
  const finalScore = Math.round(
    0.20 * clampedVelocity +
    0.20 * relevanceScore +
    0.15 * authorityScore +
    0.15 * recencyScore +
    0.20 * momentumScore +
    0.10 * sentimentScore
  );

  const clampedFinalScore = Math.min(100, Math.max(0, finalScore));

  // Calculate change percentage
  const changePercent = previousScore > 0
    ? Math.round(((clampedFinalScore - previousScore) / previousScore) * 100)
    : 0;

  // Count data sources
  const dataSourcesUsed =
    (googleTrends && googleTrends.allTrends?.length > 0 ? 1 : 0) +
    (newsData?.length > 0 && newsData.some(r => r.totalResults > 0) ? 1 : 0) +
    (serpResults?.length > 0 && serpResults.some(r => r.totalResults > 0) ? 1 : 0);

  return {
    trendScore: clampedFinalScore,
    rawScore,
    smoothedScore,
    changePercent,
    articles: articles.slice(0, 10).join('\n') || 'No articles found',
    dataSourcesUsed,
    factors: {
      velocity: Math.round(clampedVelocity),
      momentum: Math.round(momentumScore),
      sentiment: Math.round(sentimentScore),
      relevance: Math.round(relevanceScore),
      authority: Math.round(authorityScore),
      recency: Math.round(recencyScore),
    },
  };
}

// ============================================================================
// MAIN TREND ANALYSIS
// ============================================================================

/**
 * Analyze trends for a single monitor using v2 scoring
 */
async function analyzeMonitorTrends(monitor) {
  console.log(`\n  Analyzing: ${monitor.monitorId}`);
  console.log(`  Terms: ${monitor.terms.join(', ')}`);

  // Fetch data from multiple sources (multi-region for Google Trends)
  const [googleTrends, newsData, serpResults] = await Promise.all([
    fetchGoogleTrendsRSS(monitor.terms), // Now fetches US, GB, CA, AU
    fetchNewsVolume(monitor.terms),
    fetchGoogleNews(monitor.terms),
  ]);

  // Log region data
  if (googleTrends.regionData) {
    const regions = Object.entries(googleTrends.regionData)
      .map(([r, d]) => `${r}:${d.matches}`)
      .join(', ');
    console.log(`  Regions checked: ${regions}`);
  }

  // Calculate Coherence Score first (needed for confidence)
  const coherenceData = calculateCoherenceScore(googleTrends, newsData, serpResults);
  console.log(`  Coherence: ${coherenceData.coherenceScore} (${coherenceData.coherenceLevel})`);

  // Calculate Trend Score v2 (with all 6 factors)
  const trendData = calculateTrendScoreV2(googleTrends, newsData, serpResults, monitor.monitorId);

  // Calculate Confidence v2 (uses coherence)
  const confidenceData = calculateConfidenceV2(googleTrends, newsData, serpResults, coherenceData.coherenceScore);

  console.log(`  Trend Score: ${trendData.trendScore} (raw: ${trendData.rawScore}, smoothed: ${trendData.smoothedScore})`);
  console.log(`  Change: ${trendData.changePercent}%`);
  console.log(`  Confidence: ${confidenceData.confidence}`);
  console.log(`  Data Sources: ${trendData.dataSourcesUsed}`);

  // Log factor breakdown if verbose
  if (process.env.VERBOSE === 'true') {
    console.log(`  Factors: V=${trendData.factors.velocity} M=${trendData.factors.momentum} S=${trendData.factors.sentiment} R=${trendData.factors.relevance} A=${trendData.factors.authority} Re=${trendData.factors.recency}`);
    console.log(`  Coherence Factors: Dir=${coherenceData.factors.directionAgreement} Mag=${coherenceData.factors.magnitudeConsistency} Temp=${coherenceData.factors.temporalConsistency} Term=${coherenceData.factors.termCorrelation}`);
  }

  return {
    ...trendData,
    coherenceScore: coherenceData.coherenceScore,
    coherenceLevel: coherenceData.coherenceLevel,
    coherenceFactors: coherenceData.factors,
    confidence: confidenceData.confidence,
    confidenceFactors: confidenceData.factors,
    summary: `${monitor.terms[0] || 'Unknown'}: Score ${trendData.trendScore}, Coherence ${coherenceData.coherenceScore} (${coherenceData.coherenceLevel}), Change ${trendData.changePercent}%`,
  };
}

/**
 * Check if monitor interval has elapsed
 */
function shouldCheck(monitor) {
  if (!monitor.lastCheck) return true;

  const lastCheck = new Date(monitor.lastCheck);
  const now = new Date();
  const daysDiff = (now - lastCheck) / (1000 * 60 * 60 * 24);

  if (monitor.interval === 'week') {
    return daysDiff >= 7;
  } else if (monitor.interval === 'month') {
    return daysDiff >= 30;
  }

  return daysDiff >= 1; // Default: daily
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('');
  console.log('======================================================================');
  console.log('           NOTION INTEL TREND MONITOR v2                             ');
  console.log('           Multi-Factor Scoring with Coherence                       ');
  console.log('======================================================================');
  console.log('');
  console.log(`Started: ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('Mode: DRY RUN (no updates will be made)');
  if (process.env.VERBOSE === 'true') console.log('Mode: VERBOSE (detailed factor breakdowns)');
  console.log('');

  // Validate environment
  if (!process.env.NOTION_TOKEN) {
    console.error('Error: NOTION_TOKEN environment variable not set');
    process.exit(1);
  }
  if (!MONITORS_DB) {
    console.error('Error: MONITORS_DATABASE_ID environment variable not set');
    process.exit(1);
  }

  // Warn if SIGNALS_DB not configured
  if (!SIGNALS_DB) {
    console.log('Warning: SIGNALS_DATABASE_ID not set - alerts will be disabled');
  }

  // Show available data sources
  console.log('');
  console.log('Data Sources:');
  console.log(`  - Google Trends RSS: Available (regions: ${GOOGLE_TRENDS_REGIONS.join(', ')})`);
  console.log(`  - NewsData.io: ${process.env.NEWSDATA_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`  - SerpAPI: ${process.env.SERPAPI_KEY ? 'Configured' : 'Not configured'}`);
  console.log('');
  console.log('Scoring v2 Features:');
  console.log('  - 6-factor trend scoring (velocity, momentum, sentiment, relevance, authority, recency)');
  console.log('  - Coherence metric (signal quality 0-100)');
  console.log('  - EMA smoothing and recency weighting');
  console.log('');

  try {
    // Test Notion connection
    console.log('Testing Notion connection...');
    await notionRequest(() => notion.databases.retrieve({ database_id: MONITORS_DB }));
    console.log('Notion connection successful');
    console.log('');

    // Step 1: Fetch active monitors
    console.log('Step 1: Fetching active monitors...');
    const monitors = await fetchActiveMonitors();
    console.log(`  Found ${monitors.length} active monitors`);

    // Step 2: Filter monitors that need checking
    console.log('\nStep 2: Checking intervals...');
    const monitorsToCheck = monitors.filter(shouldCheck);
    console.log(`  ${monitorsToCheck.length} monitors due for check`);

    // Step 3: Analyze trends for each monitor
    console.log('\nStep 3: Analyzing trends...');
    let analyzed = 0;
    let alerts = 0;
    let errors = 0;

    for (const monitor of monitorsToCheck) {
      try {
        const trendData = await analyzeMonitorTrends(monitor);

        // Update monitor in Notion
        const updated = await updateMonitor(monitor.pageId, trendData);
        if (updated) analyzed++;

        // Check threshold and create alert if exceeded
        if (Math.abs(trendData.changePercent) >= monitor.threshold) {
          console.log(`  ⚠️ THRESHOLD EXCEEDED: ${trendData.changePercent}% (threshold: ${monitor.threshold}%)`);
          if (SIGNALS_DB) {
            // Check for duplicate before creating
            const alertExists = await alertExistsToday(monitor.monitorId);
            if (!alertExists) {
              const created = await createAlert(monitor, trendData);
              if (created) alerts++;
            } else {
              console.log(`  Skipping duplicate alert for ${monitor.monitorId}`);
            }
          }
        }

        await sleep(1000); // Rate limit between monitors
      } catch (error) {
        console.error(`  Error analyzing ${monitor.monitorId}: ${error.message}`);
        errors++;
      }
    }

    // Summary
    console.log('');
    console.log('======================================================================');
    console.log('SUMMARY');
    console.log('======================================================================');
    console.log(`Total active monitors:   ${monitors.length}`);
    console.log(`Monitors checked:        ${analyzed}`);
    console.log(`Alerts created:          ${alerts}`);
    console.log(`Errors:                  ${errors}`);
    console.log(`Completed:               ${new Date().toISOString()}`);
    console.log('');

    process.exit(errors > 0 ? 1 : 0);

  } catch (error) {
    console.error('');
    console.error('Fatal error:', error.message);
    console.error('');
    process.exit(1);
  }
}

main();
