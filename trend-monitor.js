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
 * - Google Trends RSS (via trendspyg pattern - free, no API key)
 * - NewsData.io (200 credits/day free)
 * - Google News via SerpAPI (100 searches/month free, if configured)
 *
 * Required environment variables:
 *   NOTION_TOKEN - Notion API integration token
 *   MONITORS_DATABASE_ID - Notion database ID for trend monitors
 *   SIGNALS_DATABASE_ID - Notion database ID for signals (for alerts)
 *
 * Optional:
 *   NEWSDATA_API_KEY - NewsData.io API key (free tier: 200 credits/day)
 *   SERPAPI_KEY - SerpAPI key for Google News (100 free searches/month)
 *   DRY_RUN - Set to 'true' to test without updating Notion
 */

const { Client } = require('@notionhq/client');

// Initialize Notion client
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Configuration
const MONITORS_DB = process.env.MONITORS_DATABASE_ID;
const SIGNALS_DB = process.env.SIGNALS_DATABASE_ID;
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

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
      const active = props.active?.checkbox || false;

      monitors.push({
        pageId: page.id,
        monitorId,
        terms: parseTerms(terms),
        threshold,
        interval,
        lastCheck,
        active,
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
    return;
  }

  const properties = {
    'last_check': { date: { start: new Date().toISOString().split('T')[0] } },
  };

  // Add trend_score if your database has this property
  if (results.trendScore !== undefined) {
    properties['trend_score'] = { number: results.trendScore };
  }

  // Add trend_change if your database has this property
  if (results.trendChange !== undefined) {
    properties['trend_change'] = { number: results.trendChange };
  }

  await notionRequest(() => notion.pages.update({
    page_id: pageId,
    properties,
  }));
}

/**
 * Create alert signal when threshold is exceeded
 */
async function createAlert(monitor, trendData) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would create alert for ${monitor.monitorId}`);
    return;
  }

  const alertId = `trend-alert-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  await notionRequest(() => notion.pages.create({
    parent: { database_id: SIGNALS_DB },
    icon: { type: 'emoji', emoji: '📈' },
    properties: {
      'signal_id': { title: [{ text: { content: alertId } }] },
      'entity': { rich_text: [{ text: { content: monitor.terms.join(', ').substring(0, 100) } }] },
      'signal_type': { select: { name: 'TREND' } },
      'content': { rich_text: [{ text: { content: `Trend alert: ${trendData.summary}` } }] },
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
        paragraph: { rich_text: [{ text: { content: trendData.articles || 'No related articles found' } }] }
      },
    ]
  }));
}

// ============================================================================
// TREND DATA SOURCES
// ============================================================================

/**
 * Fetch Google Trends data via RSS feed (FREE - no API key required)
 * This mimics the trendspyg library's RSS approach
 */
async function fetchGoogleTrendsRSS(geo = 'US') {
  const Parser = require('rss-parser');
  const parser = new Parser({
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
  });

  try {
    const url = `https://trends.google.com/trending/rss?geo=${geo}`;
    const feed = await parser.parseURL(url);

    return feed.items.map(item => ({
      title: item.title,
      traffic: item['ht:approx_traffic'] || 'N/A',
      pubDate: new Date(item.pubDate),
      description: item.contentSnippet || '',
    }));
  } catch (error) {
    console.error(`  Warning: Google Trends RSS error: ${error.message}`);
    return [];
  }
}

/**
 * Fetch news volume from NewsData.io (FREE tier: 200 credits/day)
 */
async function fetchNewsVolume(searchTerms, days = 7) {
  if (!process.env.NEWSDATA_API_KEY) {
    return null;
  }

  const results = [];

  for (const term of searchTerms.slice(0, 5)) { // Limit to conserve credits
    try {
      const encodedTerm = encodeURIComponent(term);
      const url = `https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_API_KEY}&q=${encodedTerm}&language=en`;

      const response = await fetch(url);
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
          link: a.link,
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
      const response = await fetch(url);

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
 */
function calculateTrendScore(googleTrends, newsData, serpResults, previousScore = 50) {
  let score = 0;
  let dataPoints = 0;
  let articles = [];

  // Factor 1: Google Trends RSS mentions
  if (googleTrends && googleTrends.length > 0) {
    // Check if any of our terms appear in trending topics
    score += 20; // Base score if we can fetch trends
    dataPoints++;
  }

  // Factor 2: NewsData.io volume
  if (newsData && newsData.length > 0) {
    const totalArticles = newsData.reduce((sum, r) => sum + r.totalResults, 0);
    // Normalize: 0-10 articles = low, 10-50 = medium, 50+ = high
    const newsScore = Math.min(40, (totalArticles / 50) * 40);
    score += newsScore;
    dataPoints++;

    // Collect article summaries
    for (const result of newsData) {
      for (const article of result.articles || []) {
        articles.push(`- ${article.title} (${article.source})`);
      }
    }
  }

  // Factor 3: SerpAPI Google News
  if (serpResults && serpResults.length > 0) {
    const totalNews = serpResults.reduce((sum, r) => sum + r.totalResults, 0);
    const serpScore = Math.min(40, (totalNews / 30) * 40);
    score += serpScore;
    dataPoints++;

    // Collect article summaries
    for (const result of serpResults) {
      for (const news of (result.newsResults || []).slice(0, 3)) {
        articles.push(`- ${news.title} (${news.source?.name || 'Unknown'})`);
      }
    }
  }

  // Normalize score
  const normalizedScore = dataPoints > 0 ? Math.round(score / dataPoints * (100 / 40)) : 50;
  const finalScore = Math.min(100, Math.max(0, normalizedScore));

  // Calculate change percentage from previous
  const changePercent = previousScore > 0
    ? Math.round(((finalScore - previousScore) / previousScore) * 100)
    : 0;

  return {
    trendScore: finalScore,
    changePercent,
    articles: articles.slice(0, 10).join('\n') || 'No articles found',
    dataSourcesUsed: dataPoints,
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
    fetchGoogleTrendsRSS('US'),
    fetchNewsVolume(monitor.terms),
    fetchGoogleNews(monitor.terms),
  ]);

  // Get previous score (you'd store this in Notion or use last_check logic)
  const previousScore = 50; // Default baseline

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

  // Show available data sources
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
        await updateMonitor(monitor.pageId, trendData);
        analyzed++;

        // Check threshold and create alert if exceeded
        if (Math.abs(trendData.changePercent) >= monitor.threshold) {
          console.log(`  ⚠️ THRESHOLD EXCEEDED: ${trendData.changePercent}% (threshold: ${monitor.threshold}%)`);
          if (SIGNALS_DB) {
            await createAlert(monitor, trendData);
            alerts++;
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
