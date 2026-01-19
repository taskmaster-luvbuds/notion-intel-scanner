#!/usr/bin/env node
/**
 * Backfill Scores Script
 *
 * One-time backfill script to populate trend scores on existing monitors
 * that were created before the scoring system was implemented.
 *
 * This script:
 * 1. Reads ALL active monitors from Notion (regardless of last_check or interval)
 * 2. Runs trend analysis on each using the scoring functions
 * 3. Fetches data from multiple sources:
 *    - Google Trends RSS (multi-region: US, GB, CA, AU)
 *    - Google News RSS (direct, no API key required)
 *    - NewsData.io API (if configured)
 *    - SerpAPI Google News (if configured)
 * 4. Writes scores (trend_score, Coherency, confidence, change_percent) to Notion
 * 5. Updates page content with rich blocks:
 *    - Trend Analysis Report header
 *    - Monitor Details section
 *    - Scoring Metrics section
 *    - Data Sources Checked section
 *    - Top Related Articles section
 *    - Summary section
 * 6. Updates last_check to today
 *
 * Usage:
 *   node backfill-scores.js           # Run backfill
 *   node backfill-scores.js --dry-run # Preview without making changes
 *
 * Required environment variables:
 *   NOTION_TOKEN - Notion API integration token
 *   MONITORS_DATABASE_ID - Notion database ID for trend monitors
 *
 * Optional:
 *   NEWSDATA_API_KEY - NewsData.io API key (free tier: 200 credits/day)
 *   SERPAPI_KEY - SerpAPI key for Google News (100 free searches/month)
 *   VERBOSE - Set to 'true' for detailed factor breakdowns
 */

const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');

// Initialize Notion client
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Configuration
const MONITORS_DB = process.env.MONITORS_DATABASE_ID;
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

// Constants
const FETCH_TIMEOUT_MS = 10000;

// Source Reliability Weights
const SOURCE_WEIGHTS = {
  googleTrends: { reliability: 0.85, weight: 0.25 },
  googleNewsRss: { reliability: 0.80, weight: 0.25 },
  newsData: { reliability: 0.80, weight: 0.25 },
  serpApi: { reliability: 0.90, weight: 0.25 },
};

// Multi-region configuration for Google Trends
const GOOGLE_TRENDS_REGIONS = ['US', 'GB', 'CA', 'AU'];

// Score history storage (in-memory for this run)
const scoreHistory = new Map();

// EMA smoothing factor
const EMA_ALPHA = 0.3;

// Recency decay constants
const RECENCY_HALF_LIFE_DAYS = 3;

// Max content length for Notion rich text
const MAX_CONTENT_LENGTH = 1900;

// ============================================================================
// HELPER FUNCTIONS (copied from trend-monitor.js)
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function calculateRecencyWeight(pubDate) {
  if (!pubDate) return 0.5;
  const articleDate = new Date(pubDate);
  const now = new Date();
  const daysDiff = (now - articleDate) / (1000 * 60 * 60 * 24);
  return Math.pow(2, -daysDiff / RECENCY_HALF_LIFE_DAYS);
}

function applyEMASmoothing(newScore, monitorId) {
  const previousScore = scoreHistory.get(monitorId);
  if (previousScore === undefined) {
    scoreHistory.set(monitorId, newScore);
    return newScore;
  }
  const smoothedScore = Math.round(EMA_ALPHA * newScore + (1 - EMA_ALPHA) * previousScore);
  scoreHistory.set(monitorId, smoothedScore);
  return smoothedScore;
}

function getPreviousScore(monitorId) {
  return scoreHistory.get(monitorId) || null;
}

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

function parseTerms(termsText) {
  if (!termsText) return [];
  return termsText
    .split(',')
    .map(term => term.trim())
    .filter(term => term.length > 0);
}

// ============================================================================
// NOTION DATABASE OPERATIONS (modified for backfill)
// ============================================================================

/**
 * Fetch ALL active monitors from Notion database
 * Unlike the regular monitor, this ignores last_check and interval
 */
async function fetchAllActiveMonitors() {
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

      const monitorId = props.monitor_id?.title?.[0]?.plain_text || page.id;
      const terms = props.terms?.rich_text?.[0]?.plain_text || '';
      const threshold = props.threshold?.number || 20;
      const interval = props.interval?.select?.name || 'week';
      const lastCheck = props.last_check?.date?.start || null;

      // Read existing scores for historical tracking
      const previousTrendScore = props.trend_score?.number || null;
      const previousCoherence = props.Coherency?.number || props.coherence?.number || null;
      const previousConfidence = props.confidence?.number || null;
      const previousChangePercent = props.change_percent?.number || null;

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
        previousChangePercent,
      });
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }

  return monitors;
}

/**
 * Update monitor scores in Notion AND update last_check
 */
async function updateMonitorScoresOnly(pageId, monitorId, results) {
  const today = new Date().toISOString().split('T')[0];

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${monitorId} with:`);
    console.log(`    - trend_score: ${results.trendScore}`);
    console.log(`    - Coherency: ${results.coherenceScore}`);
    console.log(`    - confidence: ${results.confidence}`);
    console.log(`    - change_percent: ${results.changePercent}`);
    console.log(`    - last_check: ${today}`);
    console.log(`    - source_urls: ${results.source_urls}`);
    console.log(`    - top_articles: ${results.top_articles?.substring(0, 50)}...`);
    console.log(`    - summary: ${results.summary}`);
    console.log(`    - regions_data: ${results.regions_data}`);
    return true;
  }

  try {
    const properties = {
      'last_check': { date: { start: today } },
    };

    // Add score properties
    if (results.trendScore !== undefined) {
      properties['trend_score'] = { number: results.trendScore };
    }
    if (results.coherenceScore !== undefined) {
      properties['Coherency'] = { number: results.coherenceScore };
    }
    if (results.confidence !== undefined) {
      properties['confidence'] = { number: results.confidence };
    }
    if (results.changePercent !== undefined) {
      properties['change_percent'] = { number: results.changePercent };
    }

    // Add context properties (Rich Text)
    if (results.source_urls) {
      properties['source_urls'] = {
        rich_text: [{ text: { content: results.source_urls.substring(0, 2000) } }]
      };
    }
    if (results.top_articles) {
      properties['top_articles'] = {
        rich_text: [{ text: { content: results.top_articles.substring(0, 2000) } }]
      };
    }
    if (results.summary) {
      properties['summary'] = {
        rich_text: [{ text: { content: results.summary.substring(0, 2000) } }]
      };
    }
    if (results.regions_data) {
      properties['regions_data'] = {
        rich_text: [{ text: { content: results.regions_data.substring(0, 2000) } }]
      };
    }

    await notionRequest(() => notion.pages.update({
      page_id: pageId,
      properties,
    }));
    return true;
  } catch (error) {
    if (error.message?.includes('property does not exist') || error.code === 'validation_error') {
      console.error(`  Warning: Some properties may not exist in your Notion database.`);
      console.error(`  Please add these properties to your Trend Monitors database:`);
      console.error(`    - trend_score (Number)`);
      console.error(`    - Coherency (Number)`);
      console.error(`    - confidence (Number)`);
      console.error(`    - change_percent (Number)`);
      console.error(`    - source_urls (Rich Text)`);
      console.error(`    - top_articles (Rich Text)`);
      console.error(`    - summary (Rich Text)`);
      console.error(`    - regions_data (Rich Text)`);
      console.error(`  Error: ${error.message}`);
    } else {
      console.error(`  Error updating monitor: ${error.message}`);
    }
    return false;
  }
}

/**
 * Update page content with rich blocks (Trend Analysis Report)
 * Creates structured content including:
 * - Trend Analysis Report header
 * - Monitor Details section
 * - Scoring Metrics section
 * - Data Sources Checked section
 * - Top Related Articles section
 * - Summary section
 */
async function updatePageContent(pageId, monitorId, monitor, results) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update page content for ${monitorId}`);
    return true;
  }

  try {
    // First, delete existing content blocks (to avoid duplicates on re-runs)
    const existingBlocks = await notionRequest(() => notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
    }));

    // Delete existing blocks
    for (const block of existingBlocks.results) {
      try {
        await notionRequest(() => notion.blocks.delete({ block_id: block.id }));
      } catch (err) {
        // Ignore errors deleting blocks
      }
    }

    // Determine coherence emoji
    const coherenceEmoji = results.coherenceLevel === 'High' ? '🎯' :
      results.coherenceLevel === 'Medium' ? '📊' : '⚡';

    // Build the children blocks
    const children = [
      // Header
      {
        type: 'heading_1',
        heading_1: { rich_text: [{ text: { content: '📈 Trend Analysis Report' } }] }
      },
      {
        type: 'callout',
        callout: {
          icon: { type: 'emoji', emoji: '📅' },
          rich_text: [{ text: { content: `Generated: ${new Date().toISOString().split('T')[0]}` } }]
        }
      },
      // Monitor Details section
      {
        type: 'heading_2',
        heading_2: { rich_text: [{ text: { content: 'Monitor Details' } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: `Monitor ID: ${monitorId}` } }] }
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
        bulleted_list_item: { rich_text: [{ text: { content: `Threshold: ${monitor.threshold}%` } }] }
      },
      // Scoring Metrics section
      {
        type: 'heading_2',
        heading_2: { rich_text: [{ text: { content: 'Scoring Metrics' } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: `Trend Score: ${results.trendScore} (raw: ${results.rawScore || results.trendScore})` } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: `${coherenceEmoji} Coherence: ${results.coherenceScore || 'N/A'} (${results.coherenceLevel || 'Unknown'})` } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: `Confidence: ${results.confidence || 0}%` } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: `Change: ${results.changePercent}%` } }] }
      },
    ];

    // Add Score Factors if available
    if (results.factors) {
      children.push({
        type: 'heading_3',
        heading_3: { rich_text: [{ text: { content: 'Score Factors' } }] }
      });
      children.push({
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: `Velocity: ${results.factors.velocity} | Momentum: ${results.factors.momentum} | Relevance: ${results.factors.relevance} | Authority: ${results.factors.authority} | Recency: ${results.factors.recency}` } }] }
      });
    }

    // Data Sources Checked section
    children.push({
      type: 'heading_2',
      heading_2: { rich_text: [{ text: { content: 'Data Sources Checked' } }] }
    });
    children.push({
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ text: { content: `Google Trends RSS (${GOOGLE_TRENDS_REGIONS.join(', ')})` } }] }
    });
    children.push({
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ text: { content: `Google News RSS (direct)` } }] }
    });
    if (process.env.NEWSDATA_API_KEY) {
      children.push({
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: 'NewsData.io API' } }] }
      });
    }
    if (process.env.SERPAPI_KEY) {
      children.push({
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: 'SerpAPI Google News' } }] }
      });
    }

    // Region data
    if (results.regions_data) {
      children.push({
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: `Regions: ${results.regions_data}` } }] }
      });
    }

    // Top Related Articles section
    children.push({
      type: 'heading_2',
      heading_2: { rich_text: [{ text: { content: 'Top Related Articles' } }] }
    });

    // Parse and add articles
    const articlesText = results.top_articles || results.articles || 'No articles found';
    const articleLines = articlesText.split('\n').filter(line => line.trim());

    if (articleLines.length > 0 && articleLines[0] !== 'No articles found') {
      for (const line of articleLines.slice(0, 5)) {
        // Check if it's a markdown link format [title](url)
        const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (linkMatch) {
          children.push({
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [{
                text: {
                  content: linkMatch[1],
                  link: { url: linkMatch[2] }
                }
              }]
            }
          });
        } else {
          // Plain text article
          children.push({
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [{ text: { content: line.replace(/^- /, '') } }] }
          });
        }
      }
    } else {
      children.push({
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: 'No related articles found for the monitored terms.' } }] }
      });
    }

    // Summary section
    children.push({
      type: 'heading_2',
      heading_2: { rich_text: [{ text: { content: 'Summary' } }] }
    });
    children.push({
      type: 'paragraph',
      paragraph: { rich_text: [{ text: { content: results.summary || 'No summary available.' } }] }
    });

    // Append all blocks to the page
    await notionRequest(() => notion.blocks.children.append({
      block_id: pageId,
      children,
    }));

    return true;
  } catch (error) {
    console.error(`  Warning: Error updating page content: ${error.message}`);
    return false;
  }
}

// ============================================================================
// TREND DATA SOURCES (copied from trend-monitor.js)
// ============================================================================

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

      const matchingTrends = trendingTopics.filter(topic =>
        searchTerms.some(term =>
          topic.title.toLowerCase().includes(term.toLowerCase()) ||
          topic.description.toLowerCase().includes(term.toLowerCase())
        )
      );

      allResults.allTrends.push(...trendingTopics);
      allResults.matchingTrends.push(...matchingTrends);
      allResults.regionData[geo] = {
        totalTrends: trendingTopics.length,
        matches: matchingTrends.length,
      };

      await sleep(300);
    } catch (error) {
      console.error(`  Warning: Google Trends RSS error for ${geo}: ${error.message}`);
      allResults.regionData[geo] = { totalTrends: 0, matches: 0, error: true };
    }
  }

  allResults.hasMatches = allResults.matchingTrends.length > 0;
  allResults.regionsChecked = regions.length;

  return allResults;
}

async function fetchNewsVolume(searchTerms) {
  if (!process.env.NEWSDATA_API_KEY) {
    return null;
  }

  const results = [];

  for (const term of searchTerms.slice(0, 5)) {
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

      const weightedCount = articles.reduce((sum, a) => sum + a.recencyWeight, 0);

      results.push({
        term,
        totalResults: data.totalResults || 0,
        weightedCount,
        articles,
      });

      await sleep(500);
    } catch (error) {
      console.error(`  NewsData.io error for "${term}": ${error.message}`);
    }
  }

  return results;
}

async function fetchGoogleNews(searchTerms) {
  if (!process.env.SERPAPI_KEY) {
    return null;
  }

  const results = [];

  for (const term of searchTerms.slice(0, 3)) {
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

      const weightedCount = newsResults.reduce((sum, n) => sum + n.recencyWeight, 0);

      results.push({
        term,
        newsResults,
        totalResults: newsResults.length,
        weightedCount,
      });

      await sleep(1000);
    } catch (error) {
      console.error(`  SerpAPI error for "${term}": ${error.message}`);
    }
  }

  return results;
}

/**
 * Fetch Google News RSS feed directly (FREE - no API key required)
 * Uses Google News RSS search endpoint with recency weighting
 * Endpoint: https://news.google.com/rss/search?q={searchTerms}&hl=en-US&gl=US&ceid=US:en
 */
async function fetchGoogleNewsRSS(searchTerms) {
  const parser = new Parser({
    timeout: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
  });

  const results = [];

  for (const term of searchTerms.slice(0, 5)) {
    try {
      const encodedTerm = encodeURIComponent(term);
      const url = `https://news.google.com/rss/search?q=${encodedTerm}&hl=en-US&gl=US&ceid=US:en`;
      const feed = await parser.parseURL(url);

      const articles = (feed.items || []).slice(0, 10).map(item => ({
        title: item.title || '',
        link: item.link || '',
        pubDate: item.pubDate || item.isoDate || null,
        source: item.source || extractSourceFromTitle(item.title),
        recencyWeight: calculateRecencyWeight(item.pubDate || item.isoDate),
      }));

      const weightedCount = articles.reduce((sum, a) => sum + a.recencyWeight, 0);

      results.push({
        term,
        articles,
        totalResults: articles.length,
        weightedCount,
      });

      await sleep(500); // Rate limit between terms
    } catch (error) {
      console.error(`  Google News RSS error for "${term}": ${error.message}`);
    }
  }

  return results;
}

/**
 * Extract source name from Google News RSS title
 * Google News RSS titles often end with " - Source Name"
 */
function extractSourceFromTitle(title) {
  if (!title) return 'Unknown';
  const match = title.match(/ - ([^-]+)$/);
  return match ? match[1].trim() : 'Unknown';
}

// ============================================================================
// SCORING FUNCTIONS (copied from trend-monitor.js)
// ============================================================================

function calculateCoherenceScore(googleTrends, newsData, serpResults) {
  let directionAgreement = 0;
  let magnitudeConsistency = 0;
  let temporalConsistency = 0;
  let termCorrelation = 0;

  const sourceSignals = [];

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

  const sourcesWithSignal = sourceSignals.filter(s => s.hasSignal).length;
  directionAgreement = sourceSignals.length > 0
    ? (sourcesWithSignal / sourceSignals.length) * 100
    : 0;

  if (sourceSignals.length >= 2) {
    const magnitudes = sourceSignals.map(s => s.magnitude);
    const maxMag = Math.max(...magnitudes);
    const minMag = Math.min(...magnitudes);
    magnitudeConsistency = maxMag > 0 ? (minMag / maxMag) * 100 : 0;
  } else {
    magnitudeConsistency = 50;
  }

  if (googleTrends && googleTrends.matchingTrends?.length > 0) {
    const avgRecency = googleTrends.matchingTrends.reduce(
      (sum, t) => sum + (t.recencyWeight || 0.5), 0
    ) / googleTrends.matchingTrends.length;
    temporalConsistency = avgRecency * 100;
  } else {
    temporalConsistency = 50;
  }

  const termCoverages = sourceSignals
    .filter(s => s.termCoverage !== undefined)
    .map(s => s.termCoverage);
  if (termCoverages.length > 0) {
    termCorrelation = (termCoverages.reduce((a, b) => a + b, 0) / termCoverages.length) * 100;
  } else if (googleTrends && googleTrends.regionData) {
    const regionsWithMatches = Object.values(googleTrends.regionData).filter(r => r.matches > 0).length;
    termCorrelation = (regionsWithMatches / GOOGLE_TRENDS_REGIONS.length) * 100;
  } else {
    termCorrelation = 50;
  }

  const coherenceScore = Math.round(
    0.30 * directionAgreement +
    0.25 * magnitudeConsistency +
    0.25 * temporalConsistency +
    0.20 * termCorrelation
  );

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

function calculateConfidenceV2(googleTrends, googleNewsRss, newsData, serpResults, coherenceScore) {
  let baseConfidence = 0;
  let dataPoints = 0;
  const maxDataPoints = 4; // 4 possible sources

  // Google Trends RSS
  if (googleTrends && googleTrends.allTrends?.length > 0) {
    baseConfidence += SOURCE_WEIGHTS.googleTrends.reliability * SOURCE_WEIGHTS.googleTrends.weight;
    dataPoints++;
  }

  // Google News RSS (FREE)
  if (googleNewsRss && googleNewsRss.length > 0) {
    const hasArticles = googleNewsRss.some(r => r.articles?.length > 0);
    if (hasArticles) {
      baseConfidence += SOURCE_WEIGHTS.googleNewsRss.reliability * SOURCE_WEIGHTS.googleNewsRss.weight;
      dataPoints++;
    }
  }

  // NewsData.io (requires API key)
  if (newsData && newsData.length > 0) {
    const hasData = newsData.some(r => r.totalResults > 0);
    if (hasData) {
      baseConfidence += SOURCE_WEIGHTS.newsData.reliability * SOURCE_WEIGHTS.newsData.weight;
      dataPoints++;
    }
  }

  // SerpAPI (requires API key)
  if (serpResults && serpResults.length > 0) {
    const hasData = serpResults.some(r => r.totalResults > 0);
    if (hasData) {
      baseConfidence += SOURCE_WEIGHTS.serpApi.reliability * SOURCE_WEIGHTS.serpApi.weight;
      dataPoints++;
    }
  }

  const freshnessMultiplier = 0.4 + (0.6 * (dataPoints / maxDataPoints));
  const sampleSizeMultiplier = 0.3 + (0.7 * Math.min(1, dataPoints / maxDataPoints));
  const agreementMultiplier = 0.75 + (0.40 * (coherenceScore / 100));

  let confidence = baseConfidence * freshnessMultiplier * sampleSizeMultiplier * agreementMultiplier;
  confidence = Math.min(0.98, Math.max(0.10, confidence));

  // Return as percentage (0-100) for better Notion display
  return {
    confidence: Math.round(confidence * 100),
    dataPoints,
    factors: {
      freshnessMultiplier: Math.round(freshnessMultiplier * 100) / 100,
      sampleSizeMultiplier: Math.round(sampleSizeMultiplier * 100) / 100,
      agreementMultiplier: Math.round(agreementMultiplier * 100) / 100,
    },
  };
}

function calculateTrendScoreV2(googleTrends, newsData, serpResults, monitorId) {
  let articles = [];
  const previousScore = getPreviousScore(monitorId) || 50;

  // Factor 1: Relevance (20%)
  let relevanceScore = 0;
  if (googleTrends && googleTrends.hasMatches) {
    relevanceScore = Math.min(100, googleTrends.matchingTrends.length * 25);
  }

  // Factor 2: Authority (15%)
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

    for (const result of serpResults) {
      for (const news of (result.newsResults || []).slice(0, 3)) {
        if (news.title) {
          articles.push(`- ${news.title} (${news.source?.name || 'Unknown'})`);
        }
      }
    }
  }

  authorityScore = totalWeight > 0 ? authorityScore / totalWeight : 0;

  // Factor 3: Recency (15%)
  let recencyScore = 50;

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

  // Factor 4: Momentum (20%)
  let momentumScore = 50;

  if (googleTrends && googleTrends.regionData) {
    const regionsWithMatches = Object.values(googleTrends.regionData)
      .filter(r => r.matches > 0).length;
    momentumScore = (regionsWithMatches / GOOGLE_TRENDS_REGIONS.length) * 100;
  }

  // Factor 5: Sentiment (10%) - placeholder
  const sentimentScore = 50;

  // Calculate raw score
  const rawScore = Math.round(
    0.20 * relevanceScore +
    0.15 * authorityScore +
    0.15 * recencyScore +
    0.20 * momentumScore +
    0.10 * sentimentScore +
    0.20 * 50
  );

  const smoothedScore = applyEMASmoothing(rawScore, monitorId);

  // Velocity factor
  const velocityScore = previousScore > 0
    ? 50 + ((smoothedScore - previousScore) / previousScore) * 50
    : 50;
  const clampedVelocity = Math.min(100, Math.max(0, velocityScore));

  // Final score
  const finalScore = Math.round(
    0.20 * clampedVelocity +
    0.20 * relevanceScore +
    0.15 * authorityScore +
    0.15 * recencyScore +
    0.20 * momentumScore +
    0.10 * sentimentScore
  );

  const clampedFinalScore = Math.min(100, Math.max(0, finalScore));

  const changePercent = previousScore > 0
    ? Math.round(((clampedFinalScore - previousScore) / previousScore) * 100)
    : 0;

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
// MAIN ANALYSIS FUNCTION
// ============================================================================

async function analyzeMonitorTrends(monitor) {
  console.log(`\n  Analyzing: ${monitor.monitorId}`);
  console.log(`  Terms: ${monitor.terms.join(', ')}`);

  // Fetch data from multiple sources (including Google News RSS)
  const [googleTrends, newsData, serpResults, googleNewsRSS] = await Promise.all([
    fetchGoogleTrendsRSS(monitor.terms),
    fetchNewsVolume(monitor.terms),
    fetchGoogleNews(monitor.terms),
    fetchGoogleNewsRSS(monitor.terms),
  ]);

  // Log Google News RSS results
  if (googleNewsRSS && googleNewsRSS.length > 0) {
    const totalGoogleNewsArticles = googleNewsRSS.reduce((sum, r) => sum + r.totalResults, 0);
    console.log(`  Google News RSS: ${totalGoogleNewsArticles} articles found`);
  }

  // Log region data
  if (googleTrends.regionData) {
    const regions = Object.entries(googleTrends.regionData)
      .map(([r, d]) => `${r}:${d.matches}`)
      .join(', ');
    console.log(`  Regions checked: ${regions}`);
  }

  // Calculate Coherence Score
  const coherenceData = calculateCoherenceScore(googleTrends, newsData, serpResults);
  console.log(`  Coherence: ${coherenceData.coherenceScore} (${coherenceData.coherenceLevel})`);

  // Calculate Trend Score
  const trendData = calculateTrendScoreV2(googleTrends, newsData, serpResults, monitor.monitorId);

  // Calculate Confidence (pass googleNewsRSS for proper counting)
  const confidenceData = calculateConfidenceV2(googleTrends, googleNewsRSS, newsData, serpResults, coherenceData.coherenceScore);

  console.log(`  Trend Score: ${trendData.trendScore} (raw: ${trendData.rawScore})`);
  console.log(`  Change: ${trendData.changePercent}%`);
  console.log(`  Confidence: ${confidenceData.confidence}`);
  console.log(`  Data Sources: ${trendData.dataSourcesUsed}`);

  if (process.env.VERBOSE === 'true') {
    console.log(`  Factors: V=${trendData.factors.velocity} M=${trendData.factors.momentum} S=${trendData.factors.sentiment} R=${trendData.factors.relevance} A=${trendData.factors.authority} Re=${trendData.factors.recency}`);
  }

  // Build context data for Notion properties
  // Top 5 articles with URLs (prioritize Google News RSS, then NewsData, then SerpAPI)
  const topArticles = [];

  // First, collect from Google News RSS (free, direct access)
  if (googleNewsRSS && googleNewsRSS.length > 0) {
    for (const result of googleNewsRSS) {
      for (const article of (result.articles || []).slice(0, 3)) {
        if (article.title && article.link) {
          topArticles.push(`[${article.title}](${article.link})`);
        } else if (article.title) {
          topArticles.push(article.title);
        }
        if (topArticles.length >= 5) break;
      }
      if (topArticles.length >= 5) break;
    }
  }

  // Then from NewsData if needed
  if (topArticles.length < 5 && newsData && newsData.length > 0) {
    for (const result of newsData) {
      for (const article of (result.articles || []).slice(0, 3)) {
        if (article.title && article.link) {
          topArticles.push(`[${article.title}](${article.link})`);
        } else if (article.title) {
          topArticles.push(article.title);
        }
        if (topArticles.length >= 5) break;
      }
      if (topArticles.length >= 5) break;
    }
  }

  // Finally from SerpAPI if still needed
  if (topArticles.length < 5 && serpResults && serpResults.length > 0) {
    for (const result of serpResults) {
      for (const news of (result.newsResults || []).slice(0, 3)) {
        if (news.title && news.link) {
          topArticles.push(`[${news.title}](${news.link})`);
        } else if (news.title) {
          topArticles.push(news.title);
        }
        if (topArticles.length >= 5) break;
      }
      if (topArticles.length >= 5) break;
    }
  }

  // Source URLs checked
  const sourceUrls = [];
  sourceUrls.push(`Google Trends RSS (${GOOGLE_TRENDS_REGIONS.join(', ')})`);
  sourceUrls.push('Google News RSS (direct)');
  if (process.env.NEWSDATA_API_KEY) {
    sourceUrls.push('NewsData.io API');
  }
  if (process.env.SERPAPI_KEY) {
    sourceUrls.push('SerpAPI Google News');
  }

  // Region match summary
  const regionsData = googleTrends.regionData
    ? Object.entries(googleTrends.regionData)
        .map(([region, data]) => `${region}: ${data.matches} matches`)
        .join(', ')
    : 'No region data';

  // Summary text
  const summary = `${monitor.terms[0] || 'Unknown'}: Score ${trendData.trendScore}, Coherence ${coherenceData.coherenceScore} (${coherenceData.coherenceLevel}), Change ${trendData.changePercent}%`;

  return {
    ...trendData,
    coherenceScore: coherenceData.coherenceScore,
    coherenceLevel: coherenceData.coherenceLevel,
    confidence: confidenceData.confidence,
    // Context data for Notion properties
    top_articles: topArticles.slice(0, 5).join('\n') || 'No articles found',
    source_urls: sourceUrls.join(', '),
    regions_data: regionsData,
    summary: summary,
    // Additional data for page content
    googleNewsRSSCount: googleNewsRSS ? googleNewsRSS.reduce((sum, r) => sum + r.totalResults, 0) : 0,
  };
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('');
  console.log('======================================================================');
  console.log('           BACKFILL SCORES SCRIPT                                     ');
  console.log('           Populate scores on existing monitors                       ');
  console.log('======================================================================');
  console.log('');
  console.log(`Started: ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('Mode: DRY RUN (no updates will be made)');
  if (process.env.VERBOSE === 'true') console.log('Mode: VERBOSE (detailed factor breakdowns)');
  console.log('');
  console.log('NOTE: This script updates last_check dates to today.');
  console.log('      All monitors will show as freshly checked.');
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

  // Show available data sources
  console.log('Data Sources:');
  console.log(`  - Google Trends RSS: Available (regions: ${GOOGLE_TRENDS_REGIONS.join(', ')})`);
  console.log(`  - Google News RSS: Available (direct, no API key required)`);
  console.log(`  - NewsData.io: ${process.env.NEWSDATA_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`  - SerpAPI: ${process.env.SERPAPI_KEY ? 'Configured' : 'Not configured'}`);
  console.log('');
  console.log('Page Content:');
  console.log('  - Creates rich blocks with Trend Analysis Report');
  console.log('  - Includes Monitor Details, Scoring Metrics, Data Sources, Articles, Summary');
  console.log('');

  try {
    // Test Notion connection
    console.log('Testing Notion connection...');
    await notionRequest(() => notion.databases.retrieve({ database_id: MONITORS_DB }));
    console.log('Notion connection successful');
    console.log('');

    // Fetch ALL active monitors (ignoring last_check and interval)
    console.log('Fetching ALL active monitors...');
    const monitors = await fetchAllActiveMonitors();
    console.log(`  Found ${monitors.length} active monitors to backfill`);

    // Show which monitors already have scores
    const withScores = monitors.filter(m => m.previousTrendScore !== null);
    const withoutScores = monitors.filter(m => m.previousTrendScore === null);
    console.log(`  - ${withScores.length} already have scores (will be updated)`);
    console.log(`  - ${withoutScores.length} have no scores (will be populated)`);

    // Process each monitor
    console.log('\nProcessing monitors...');
    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < monitors.length; i++) {
      const monitor = monitors[i];
      console.log(`\n[${i + 1}/${monitors.length}] Processing: ${monitor.monitorId}`);

      // Skip monitors with no terms
      if (monitor.terms.length === 0) {
        console.log(`  Skipping: No search terms defined`);
        skipped++;
        continue;
      }

      try {
        // Analyze trends
        const trendData = await analyzeMonitorTrends(monitor);

        // Update scores in Notion (updates last_check to today)
        const success = await updateMonitorScoresOnly(
          monitor.pageId,
          monitor.monitorId,
          trendData
        );

        if (success) {
          // Update page content with rich blocks (Trend Analysis Report)
          const contentSuccess = await updatePageContent(
            monitor.pageId,
            monitor.monitorId,
            monitor,
            trendData
          );

          if (contentSuccess) {
            console.log(`  Page content updated with rich blocks`);
          }

          updated++;
          console.log(`  Updated successfully`);
        } else {
          errors++;
        }

        processed++;

        // Rate limit between monitors
        await sleep(1500);

      } catch (error) {
        console.error(`  Error processing ${monitor.monitorId}: ${error.message}`);
        errors++;
      }
    }

    // Summary
    console.log('');
    console.log('======================================================================');
    console.log('BACKFILL COMPLETE');
    console.log('======================================================================');
    console.log(`Total active monitors:   ${monitors.length}`);
    console.log(`Processed:               ${processed}`);
    console.log(`Updated:                 ${updated}`);
    console.log(`Skipped (no terms):      ${skipped}`);
    console.log(`Errors:                  ${errors}`);
    console.log(`Completed:               ${new Date().toISOString()}`);
    console.log('');

    if (DRY_RUN) {
      console.log('This was a DRY RUN. Run without --dry-run to apply changes.');
      console.log('');
    }

    process.exit(errors > 0 ? 1 : 0);

  } catch (error) {
    console.error('');
    console.error('Fatal error:', error.message);
    console.error('');
    process.exit(1);
  }
}

main();
