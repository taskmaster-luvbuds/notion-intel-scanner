#!/usr/bin/env node
/**
 * Notion INTEL Trend Monitor
 *
 * Automated trend monitoring system that:
 * 1. Reads active monitors from Notion database
 * 2. Performs trend analysis using multiple data sources
 * 3. Updates monitors with trend scores
 * 4. Creates alerts when thresholds are exceeded
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

      monitors.push({
        pageId: page.id,
        monitorId,
        terms: parseTerms(terms),
        threshold,
        interval,
        lastCheck,
      });
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }

  return monitors;
}

/**
 * Update monitor in Notion with trend results
 */
async function updateMonitor(pageId, results) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update monitor ${pageId}`);
    return true;
  }

  try {
    const properties = {
      'last_check': { date: { start: new Date().toISOString().split('T')[0] } },
    };

    await notionRequest(() => notion.pages.update({
      page_id: pageId,
      properties,
    }));
    return true;
  } catch (error) {
    console.error(`  Warning: Error updating monitor: ${error.message}`);
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
 * Create alert signal when threshold is exceeded
 */
async function createAlert(monitor, trendData) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would create alert for ${monitor.monitorId}`);
    return true;
  }

  try {
    const alertId = `trend-alert-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const articlesContent = (trendData.articles || 'No related articles found').substring(0, MAX_CONTENT_LENGTH);

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
          bulleted_list_item: { rich_text: [{ text: { content: `Trend Score: ${trendData.trendScore}` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Change: ${trendData.changePercent}%` } }] }
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
 * Note: This fetches what's trending globally, then we check if our terms appear
 */
async function fetchGoogleTrendsRSS(searchTerms, geo = 'US') {
  const parser = new Parser({
    timeout: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
  });

  try {
    // Correct URL for Google Trends daily RSS
    const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`;
    const feed = await parser.parseURL(url);

    const trendingTopics = feed.items.map(item => ({
      title: item.title,
      traffic: item['ht:approx_traffic'] || 'N/A',
      pubDate: new Date(item.pubDate),
      description: item.contentSnippet || '',
    }));

    // Check if any of our search terms appear in trending topics
    const matchingTrends = trendingTopics.filter(topic =>
      searchTerms.some(term =>
        topic.title.toLowerCase().includes(term.toLowerCase()) ||
        topic.description.toLowerCase().includes(term.toLowerCase())
      )
    );

    return {
      allTrends: trendingTopics,
      matchingTrends,
      hasMatches: matchingTrends.length > 0,
    };
  } catch (error) {
    console.error(`  Warning: Google Trends RSS error: ${error.message}`);
    return { allTrends: [], matchingTrends: [], hasMatches: false };
  }
}

/**
 * Fetch news volume from NewsData.io (FREE tier: 200 credits/day)
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

      results.push({
        term,
        totalResults: data.totalResults || 0,
        articles: (data.results || []).slice(0, 5).map(a => ({
          title: a.title,
          source: a.source_id,
          pubDate: a.pubDate,
          link: isValidUrl(a.link) ? a.link : null,
        })),
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

      results.push({
        term,
        newsResults: data.news_results || [],
        totalResults: (data.news_results || []).length,
      });

      await sleep(1000); // Rate limit
    } catch (error) {
      console.error(`  SerpAPI error for "${term}": ${error.message}`);
    }
  }

  return results;
}

/**
 * Calculate trend score from multiple data sources
 * Returns a normalized score 0-100 and change percentage
 *
 * Scoring: Each source contributes up to 40 points, normalized to 0-100
 */
function calculateTrendScore(googleTrends, newsData, serpResults, previousScore = 50) {
  let score = 0;
  let maxPossibleScore = 0;
  let articles = [];

  // Factor 1: Google Trends RSS - bonus if our terms are trending
  if (googleTrends) {
    maxPossibleScore += 40;
    if (googleTrends.hasMatches) {
      // High score if our terms appear in trending topics
      score += 40;
    } else if (googleTrends.allTrends.length > 0) {
      // Small score just for being able to fetch data
      score += 5;
    }
  }

  // Factor 2: NewsData.io volume
  if (newsData && newsData.length > 0) {
    maxPossibleScore += 40;
    const totalArticles = newsData.reduce((sum, r) => sum + r.totalResults, 0);
    // Normalize: 0-10 articles = low, 10-50 = medium, 50+ = high
    const newsScore = Math.min(40, (totalArticles / 50) * 40);
    score += newsScore;

    // Collect article summaries
    for (const result of newsData) {
      for (const article of result.articles || []) {
        if (article.title) {
          articles.push(`- ${article.title} (${article.source || 'Unknown'})`);
        }
      }
    }
  }

  // Factor 3: SerpAPI Google News
  if (serpResults && serpResults.length > 0) {
    maxPossibleScore += 40;
    const totalNews = serpResults.reduce((sum, r) => sum + r.totalResults, 0);
    const serpScore = Math.min(40, (totalNews / 30) * 40);
    score += serpScore;

    // Collect article summaries
    for (const result of serpResults) {
      for (const news of (result.newsResults || []).slice(0, 3)) {
        if (news.title) {
          articles.push(`- ${news.title} (${news.source?.name || 'Unknown'})`);
        }
      }
    }
  }

  // Normalize score: scale to 0-100 based on max possible
  const normalizedScore = maxPossibleScore > 0
    ? Math.round((score / maxPossibleScore) * 100)
    : 50;
  const finalScore = Math.min(100, Math.max(0, normalizedScore));

  // Calculate change percentage from previous
  const changePercent = previousScore > 0
    ? Math.round(((finalScore - previousScore) / previousScore) * 100)
    : 0;

  return {
    trendScore: finalScore,
    changePercent,
    articles: articles.slice(0, 10).join('\n') || 'No articles found',
    dataSourcesUsed: (googleTrends ? 1 : 0) + (newsData?.length > 0 ? 1 : 0) + (serpResults?.length > 0 ? 1 : 0),
  };
}

// ============================================================================
// MAIN TREND ANALYSIS
// ============================================================================

/**
 * Analyze trends for a single monitor
 */
async function analyzeMonitorTrends(monitor) {
  console.log(`\n  Analyzing: ${monitor.monitorId}`);
  console.log(`  Terms: ${monitor.terms.join(', ')}`);

  // Fetch data from multiple sources
  const [googleTrends, newsData, serpResults] = await Promise.all([
    fetchGoogleTrendsRSS(monitor.terms, 'US'),
    fetchNewsVolume(monitor.terms),
    fetchGoogleNews(monitor.terms),
  ]);

  // Get previous score (default baseline)
  const previousScore = 50;

  // Calculate combined trend score
  const trendData = calculateTrendScore(googleTrends, newsData, serpResults, previousScore);

  console.log(`  Trend Score: ${trendData.trendScore}`);
  console.log(`  Change: ${trendData.changePercent}%`);
  console.log(`  Data Sources Used: ${trendData.dataSourcesUsed}`);

  return {
    ...trendData,
    summary: `${monitor.terms[0] || 'Unknown'}: Score ${trendData.trendScore}, Change ${trendData.changePercent}%`,
    confidence: Math.min(0.95, 0.5 + (trendData.dataSourcesUsed * 0.15)),
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
  console.log('           NOTION INTEL TREND MONITOR                                ');
  console.log('           Automated Trend Analysis System                           ');
  console.log('======================================================================');
  console.log('');
  console.log(`Started: ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('Mode: DRY RUN (no updates will be made)');
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
  console.log(`  - Google Trends RSS: Available (free)`);
  console.log(`  - NewsData.io: ${process.env.NEWSDATA_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`  - SerpAPI: ${process.env.SERPAPI_KEY ? 'Configured' : 'Not configured'}`);
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
