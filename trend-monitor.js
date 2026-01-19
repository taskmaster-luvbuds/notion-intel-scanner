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
 * - Google News RSS (search-based news - free, no API key)
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
const { calculateSentiment, calculateArticleSentiment } = require('./sentiment');

// Initialize Notion client
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Configuration
const MONITORS_DB = process.env.MONITORS_DATABASE_ID;
const SIGNALS_DB = process.env.SIGNALS_DATABASE_ID;
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

// Constants
const FETCH_TIMEOUT_MS = 10000;
const MAX_CONTENT_LENGTH = 1900;

// Source Reliability Weights (Enhanced with all sources)
const SOURCE_WEIGHTS = {
  googleTrends: { reliability: 0.85, weight: 0.14 },
  googleNewsRss: { reliability: 0.80, weight: 0.14 },  // Free Google News RSS
  newsData: { reliability: 0.80, weight: 0.14 },
  serpApi: { reliability: 0.90, weight: 0.14 },
  hackerNews: { reliability: 0.85, weight: 0.14 },     // HackerNews Algolia API (free)
  reddit: { reliability: 0.70, weight: 0.10 },         // Reddit JSON API (free)
  additionalRss: { reliability: 0.80, weight: 0.20 },  // BBC, Guardian
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
// ARTICLE DEDUPLICATION
// ============================================================================

/**
 * Normalize URL for comparison (remove tracking params, etc.)
 */
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                           'ref', 'source', 'fbclid', 'gclid', 'msclkid'];
    trackingParams.forEach(param => parsed.searchParams.delete(param));
    return parsed.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Calculate title similarity using Jaccard coefficient
 */
function calculateTitleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;
  const normalize = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const words1 = new Set(normalize(title1));
  const words2 = new Set(normalize(title2));
  if (words1.size === 0 || words2.size === 0) return 0;
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

/**
 * Deduplicate articles from multiple sources
 * Returns deduplicated array with duplicates merged
 */
function deduplicateArticles(articles, similarityThreshold = 0.6) {
  if (!articles || articles.length === 0) {
    return { articles: [], originalCount: 0, deduplicatedCount: 0 };
  }

  const originalCount = articles.length;
  const seen = new Map();
  const titleGroups = [];
  const result = [];

  for (const article of articles) {
    const normalizedUrl = normalizeUrl(article.link || article.url);

    // Check URL-based deduplication first
    if (normalizedUrl && seen.has(normalizedUrl)) {
      const existing = seen.get(normalizedUrl);
      existing.sources = existing.sources || [existing.source];
      if (article.source && !existing.sources.includes(article.source)) {
        existing.sources.push(article.source);
      }
      continue;
    }

    // Check title similarity
    let foundSimilar = false;
    for (const group of titleGroups) {
      const similarity = calculateTitleSimilarity(article.title, group[0].title);
      if (similarity >= similarityThreshold) {
        group.push(article);
        const existing = group[0];
        existing.sources = existing.sources || [existing.source];
        if (article.source && !existing.sources.includes(article.source)) {
          existing.sources.push(article.source);
        }
        foundSimilar = true;
        break;
      }
    }

    if (!foundSimilar) {
      titleGroups.push([article]);
      if (normalizedUrl) {
        seen.set(normalizedUrl, article);
      }
      article.sources = article.sources || [article.source];
      result.push(article);
    }
  }

  return {
    articles: result,
    originalCount,
    deduplicatedCount: result.length,
  };
}

// ============================================================================
// TREND DIRECTION INDICATOR
// ============================================================================

/**
 * Calculate trend direction based on change percentage
 * Returns: direction, emoji, strength, and description
 */
function calculateTrendDirection(currentScore, previousScore, changePercent) {
  let direction, emoji, strength, description;

  if (changePercent > 20) {
    direction = 'up'; emoji = '🚀'; strength = 'strong'; description = 'Strong upward trend';
  } else if (changePercent > 10) {
    direction = 'up'; emoji = '📈'; strength = 'moderate'; description = 'Moderate upward trend';
  } else if (changePercent > 3) {
    direction = 'up'; emoji = '↗️'; strength = 'weak'; description = 'Weak upward trend';
  } else if (changePercent < -20) {
    direction = 'down'; emoji = '📉'; strength = 'strong'; description = 'Strong downward trend';
  } else if (changePercent < -10) {
    direction = 'down'; emoji = '⬇️'; strength = 'moderate'; description = 'Moderate downward trend';
  } else if (changePercent < -3) {
    direction = 'down'; emoji = '↘️'; strength = 'weak'; description = 'Weak downward trend';
  } else {
    direction = 'stable'; emoji = '➡️'; strength = 'stable'; description = 'Stable trend';
  }

  return { direction, emoji, strength, description, currentScore, previousScore, changePercent };
}

/**
 * Calculate momentum trend based on regional consistency and article timing
 */
function calculateMomentumTrend(regionData, articleTimestamps) {
  let regionScore = 0;
  let recencyScore = 50;

  if (regionData) {
    const regions = Object.values(regionData);
    const totalRegions = regions.length;
    const regionsWithMatches = regions.filter(r => r.matches > 0).length;
    regionScore = totalRegions > 0 ? (regionsWithMatches / totalRegions) * 100 : 0;
  }

  if (articleTimestamps && articleTimestamps.length > 0) {
    const now = new Date();
    const last24Hours = articleTimestamps.filter(ts => {
      const articleDate = new Date(ts);
      const hoursDiff = (now - articleDate) / (1000 * 60 * 60);
      return hoursDiff <= 24;
    }).length;

    const last48Hours = articleTimestamps.filter(ts => {
      const articleDate = new Date(ts);
      const hoursDiff = (now - articleDate) / (1000 * 60 * 60);
      return hoursDiff > 24 && hoursDiff <= 48;
    }).length;

    if (last24Hours > last48Hours * 1.5) {
      recencyScore = 100; // Accelerating
    } else if (last24Hours > last48Hours * 0.75) {
      recencyScore = 50; // Steady
    } else {
      recencyScore = 0; // Decelerating
    }
  }

  const combinedScore = (regionScore * 0.4) + (recencyScore * 0.6);

  if (combinedScore >= 70) return 'accelerating';
  else if (combinedScore >= 30) return 'steady';
  else return 'decelerating';
}

// ============================================================================
// ACTION RECOMMENDATIONS ENGINE
// ============================================================================

/**
 * Generate action recommendations based on trend, coherence, and confidence data
 * @param {object} trendData - Trend score data including trendScore, factors, changePercent
 * @param {object} coherenceData - Coherence score data including coherenceScore, coherenceLevel
 * @param {object} confidenceData - Confidence data including confidence percentage
 * @param {object} monitor - Monitor object with terms and other details
 * @returns {array} Array of recommendation objects with priority and text
 */
function generateActionRecommendations(trendData, coherenceData, confidenceData, monitor) {
  const recommendations = [];
  const term = monitor.terms[0] || 'this topic';
  const trendScore = trendData.trendScore || 0;
  const coherence = coherenceData.coherenceScore || 0;
  const confidence = confidenceData.confidence || 0;
  const sentiment = trendData.factors?.sentiment || 50;

  // High Priority Actions (trendScore > 70 AND coherence > 60)
  if (trendScore > 70 && coherence > 60) {
    recommendations.push({
      priority: 'high',
      text: `Create content about ${term} - high trending activity detected`
    });
    recommendations.push({
      priority: 'high',
      text: 'Consider market entry - strong positive signal across sources'
    });
    recommendations.push({
      priority: 'high',
      text: 'Monitor competitor activity - trend gaining momentum'
    });
  }
  // Medium Priority Actions (trendScore 40-70 OR coherence 40-60)
  else if ((trendScore >= 40 && trendScore <= 70) || (coherence >= 40 && coherence <= 60)) {
    recommendations.push({
      priority: 'medium',
      text: 'Track this trend - moderate activity detected'
    });
    recommendations.push({
      priority: 'medium',
      text: 'Research deeper - mixed signals need clarification'
    });
    recommendations.push({
      priority: 'medium',
      text: 'Set up alerts - potential emerging opportunity'
    });
  }
  // Low Priority Actions (trendScore < 40)
  else if (trendScore < 40) {
    recommendations.push({
      priority: 'low',
      text: 'Continue monitoring - no significant activity'
    });
    recommendations.push({
      priority: 'low',
      text: 'Review search terms - may need refinement'
    });
    recommendations.push({
      priority: 'low',
      text: 'Check back next cycle - insufficient data'
    });
  }

  // Confidence-based modifiers
  if (confidence < 30) {
    recommendations.push({
      priority: 'low',
      text: 'Low confidence - gather more data before acting',
      isModifier: true
    });
  } else if (confidence > 70) {
    recommendations.push({
      priority: 'high',
      text: 'High confidence signal - action recommended',
      isModifier: true
    });
  }

  // Sentiment-based additions
  if (sentiment < 40) {
    recommendations.push({
      priority: 'medium',
      text: 'Caution: Negative sentiment detected',
      isModifier: true
    });
  } else if (sentiment > 60) {
    recommendations.push({
      priority: 'medium',
      text: 'Positive sentiment - favorable environment',
      isModifier: true
    });
  }

  return recommendations;
}

/**
 * Prioritize and format recommendations
 * @param {array} recommendations - Array of recommendation objects
 * @returns {array} Sorted and limited array with priority emojis
 */
function prioritizeRecommendations(recommendations) {
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };

  // Sort by priority
  const sorted = recommendations.sort((a, b) => {
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });

  // Add emoji and limit to top 3
  return sorted.slice(0, 3).map(rec => ({
    ...rec,
    formattedText: `${priorityEmoji[rec.priority]} ${rec.text}`
  }));
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
 * Clear all existing blocks from a Notion page
 */
async function clearPageContent(pageId) {
  try {
    // Fetch all existing blocks
    const response = await notionRequest(() => notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
    }));

    // Delete each block
    for (const block of response.results) {
      await notionRequest(() => notion.blocks.delete({
        block_id: block.id,
      }));
      await sleep(100); // Rate limit
    }

    return true;
  } catch (error) {
    console.error(`  Warning: Error clearing page content: ${error.message}`);
    return false;
  }
}

/**
 * Update monitor page CONTENT with rich blocks (similar to INTEL Signals)
 * Creates a Trend Analysis Report with detailed metrics and articles
 */
async function updateMonitorContent(pageId, monitor, results) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update page content for ${pageId}`);
    return true;
  }

  try {
    // Clear existing content first
    await clearPageContent(pageId);

    const now = new Date().toISOString().split('T')[0];

    // Determine coherence emoji
    const coherenceEmoji = results.coherenceLevel === 'High' ? '🎯' :
      results.coherenceLevel === 'Medium' ? '📊' : '⚡';

    // Build the blocks array
    const blocks = [
      // Main heading
      {
        type: 'heading_2',
        heading_2: { rich_text: [{ text: { content: '📊 Trend Analysis Report' } }] }
      },
      // Last updated
      {
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: `Last Updated: ${now}` } }] }
      },
      // Monitor Details section
      {
        type: 'heading_3',
        heading_3: { rich_text: [{ text: { content: 'Monitor Details' } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [
          { text: { content: 'Terms: ' }, annotations: { bold: true } },
          { text: { content: monitor.terms.join(', ') } }
        ] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [
          { text: { content: 'Interval: ' }, annotations: { bold: true } },
          { text: { content: monitor.interval } }
        ] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [
          { text: { content: 'Threshold: ' }, annotations: { bold: true } },
          { text: { content: `${monitor.threshold}%` } }
        ] }
      },
      // Scoring Metrics section
      {
        type: 'heading_3',
        heading_3: { rich_text: [{ text: { content: 'Scoring Metrics' } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [
          { text: { content: 'Trend Score: ' }, annotations: { bold: true } },
          { text: { content: `${results.trendScore}/100` } }
        ] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [
          { text: { content: `${coherenceEmoji} Coherence: ` }, annotations: { bold: true } },
          { text: { content: `${results.coherenceScore}/100 (${results.coherenceLevel})` } }
        ] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [
          { text: { content: 'Confidence: ' }, annotations: { bold: true } },
          { text: { content: `${results.confidence}%` } }
        ] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [
          { text: { content: 'Change: ' }, annotations: { bold: true } },
          { text: { content: `${results.changePercent}%` } }
        ] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [
          { text: { content: 'Trend Direction: ' }, annotations: { bold: true } },
          { text: { content: `${results.trendDirection?.emoji || '➡️'} ${results.trendDirection?.description || 'Stable trend'} (${results.trendDirection?.strength || 'stable'})` } }
        ] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [
          { text: { content: 'Momentum: ' }, annotations: { bold: true } },
          { text: { content: results.momentumTrend ? results.momentumTrend.charAt(0).toUpperCase() + results.momentumTrend.slice(1) : 'Steady' } }
        ] }
      },
      // Data Sources Checked section
      {
        type: 'heading_3',
        heading_3: { rich_text: [{ text: { content: 'Data Sources Checked' } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: `Google Trends RSS (${GOOGLE_TRENDS_REGIONS.join(', ')}): ${results.regionsData || 'N/A'}` } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: `Google News RSS: ${results.googleNewsRssArticleCount || 0} articles found` } }] }
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: `Data sources used: ${results.dataSourcesUsed}` } }] }
      },
    ];

    // Add Top Related Articles section
    blocks.push({
      type: 'heading_3',
      heading_3: { rich_text: [{ text: { content: 'Top Related Articles' } }] }
    });

    // Parse top articles and add them as numbered list items with links
    if (results.topArticles && results.topArticles.trim()) {
      const articleLines = results.topArticles.split('\n').filter(line => line.trim());

      for (let i = 0; i < articleLines.length; i++) {
        const line = articleLines[i];
        // Parse markdown link format: [Title](URL)
        const match = line.match(/\[([^\]]+)\]\(([^)]+)\)/);

        if (match) {
          const title = match[1];
          const url = match[2];
          blocks.push({
            type: 'numbered_list_item',
            numbered_list_item: { rich_text: [
              { text: { content: title, link: { url: url } } }
            ] }
          });
        } else {
          // Fallback: just add as text
          blocks.push({
            type: 'numbered_list_item',
            numbered_list_item: { rich_text: [{ text: { content: line } }] }
          });
        }
      }
    } else {
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: 'No related articles found.' } }] }
      });
    }

    // Add Recommended Actions section
    if (results.prioritizedRecommendations && results.prioritizedRecommendations.length > 0) {
      blocks.push({
        type: 'heading_3',
        heading_3: { rich_text: [{ text: { content: 'Recommended Actions' } }] }
      });

      for (const rec of results.prioritizedRecommendations) {
        const confidenceQualifier = results.confidence < 30 ? ' (low confidence)' :
          results.confidence > 70 ? ' (high confidence)' : '';
        blocks.push({
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `${rec.formattedText}${confidenceQualifier}` } }] }
        });
      }
    }

    // Add Summary section
    blocks.push({
      type: 'heading_3',
      heading_3: { rich_text: [{ text: { content: 'Summary' } }] }
    });

    // Build summary explanation
    let summaryText = results.contextSummary || 'No summary available.';

    // Add score interpretation
    if (results.trendScore >= 70) {
      summaryText += '\n\nThis indicates a strong trending signal with high activity across monitored sources.';
    } else if (results.trendScore >= 40) {
      summaryText += '\n\nThis indicates moderate trending activity. Worth monitoring for changes.';
    } else {
      summaryText += '\n\nThis indicates low trending activity. The topic is not currently trending significantly.';
    }

    // Add coherence interpretation
    if (results.coherenceLevel === 'High') {
      summaryText += ' The high coherence score indicates strong agreement across data sources, making this a reliable signal.';
    } else if (results.coherenceLevel === 'Medium') {
      summaryText += ' The medium coherence score suggests moderate agreement across sources.';
    } else {
      summaryText += ' The low coherence score suggests inconsistent signals across sources - interpret with caution.';
    }

    blocks.push({
      type: 'paragraph',
      paragraph: { rich_text: [{ text: { content: summaryText } }] }
    });

    // Add divider
    blocks.push({
      type: 'divider',
      divider: {}
    });

    // Add factor breakdown if available
    if (results.factors) {
      blocks.push({
        type: 'heading_3',
        heading_3: { rich_text: [{ text: { content: 'Score Factor Breakdown' } }] }
      });
      blocks.push({
        type: 'paragraph',
        paragraph: { rich_text: [{ text: {
          content: `Velocity: ${results.factors.velocity} | Momentum: ${results.factors.momentum} | Sentiment: ${results.factors.sentiment} | Relevance: ${results.factors.relevance} | Authority: ${results.factors.authority} | Recency: ${results.factors.recency}`
        } }] }
      });
    }

    // Append blocks to the page
    await notionRequest(() => notion.blocks.children.append({
      block_id: pageId,
      children: blocks,
    }));

    return true;
  } catch (error) {
    console.error(`  Warning: Error updating page content: ${error.message}`);
    return false;
  }
}

/**
 * Update monitor in Notion with trend results
 * Writes: last_check, trend_score, coherence, confidence, and context properties
 */
async function updateMonitor(pageId, results) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update monitor ${pageId} with:`);
    console.log(`    - trend_score: ${results.trendScore}`);
    console.log(`    - coherence: ${results.coherenceScore}`);
    console.log(`    - confidence: ${results.confidence}`);
    console.log(`    - top_articles: ${results.topArticles ? results.topArticles.substring(0, 50) + '...' : '(none)'}`);
    console.log(`    - source_urls: ${results.sourceUrls ? results.sourceUrls.split('\n').length + ' URLs' : '(none)'}`);
    console.log(`    - regions_data: ${results.regionsData || '(none)'}`);
    console.log(`    - summary: ${results.contextSummary || '(none)'}`);
    console.log(`    - recommendations: ${results.recommendations ? results.recommendations.substring(0, 100) + '...' : '(none)'}`);
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

    // Add context properties (Rich Text) - truncate to stay within Notion limits
    if (results.topArticles) {
      properties['top_articles'] = {
        rich_text: [{ text: { content: results.topArticles.substring(0, MAX_CONTENT_LENGTH) } }]
      };
    }
    if (results.sourceUrls) {
      properties['source_urls'] = {
        rich_text: [{ text: { content: results.sourceUrls.substring(0, MAX_CONTENT_LENGTH) } }]
      };
    }
    if (results.regionsData) {
      properties['regions_data'] = {
        rich_text: [{ text: { content: results.regionsData.substring(0, MAX_CONTENT_LENGTH) } }]
      };
    }
    if (results.contextSummary) {
      properties['summary'] = {
        rich_text: [{ text: { content: results.contextSummary.substring(0, MAX_CONTENT_LENGTH) } }]
      };
    }
    if (results.recommendations) {
      properties['recommendations'] = {
        rich_text: [{ text: { content: results.recommendations.substring(0, 2000) } }]
      };
    }

    await notionRequest(() => notion.pages.update({
      page_id: pageId,
      properties,
    }));
    return true;
  } catch (error) {
    // If property doesn't exist, log warning with details
    if (error.message?.includes('property does not exist') || error.code === 'validation_error') {
      console.error(`  Warning: Some properties may not exist in your Notion database.`);
      console.error(`  Please add these properties to your Trend Monitors database:`);
      console.error(`    Number properties:`);
      console.error(`      - trend_score (Number) - stores the calculated trend score 0-100`);
      console.error(`      - Coherency (Number) - stores the coherence score 0-100`);
      console.error(`      - confidence (Number) - stores the confidence 0.0-1.0`);
      console.error(`      - change_percent (Number) - stores the % change from previous`);
      console.error(`    Rich Text properties:`);
      console.error(`      - top_articles (Rich Text) - top 3 article links`);
      console.error(`      - source_urls (Rich Text) - URLs checked`);
      console.error(`      - regions_data (Rich Text) - region match summary`);
      console.error(`      - summary (Rich Text) - what was found`);
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
          bulleted_list_item: { rich_text: [{ text: { content: `Confidence: ${trendData.confidence}%` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Change: ${trendData.changePercent}%` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Trend Direction: ${trendData.trendDirection?.emoji || '➡️'} ${trendData.trendDirection?.description || 'Stable'} (${trendData.trendDirection?.strength || 'stable'})` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Momentum: ${trendData.momentumTrend ? trendData.momentumTrend.charAt(0).toUpperCase() + trendData.momentumTrend.slice(1) : 'Steady'}` } }] }
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
          heading_3: { rich_text: [{ text: { content: 'Recommended Action' } }] }
        },
        {
          type: 'callout',
          callout: {
            icon: { type: 'emoji', emoji: '💡' },
            rich_text: [{ text: { content: trendData.topRecommendation || 'No recommendations available' } }]
          }
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
 * Fetch Google News RSS (FREE - no API key required)
 * Uses Google News search RSS feed to get recent articles for search terms
 * Endpoint: https://news.google.com/rss/search?q={searchTerms}&hl=en-US&gl=US&ceid=US:en
 */
async function fetchGoogleNewsRSS(searchTerms) {
  const parser = new Parser({
    timeout: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
  });

  const results = [];

  for (const term of searchTerms.slice(0, 5)) { // Limit to 5 terms
    try {
      const encodedTerm = encodeURIComponent(term);
      const url = `https://news.google.com/rss/search?q=${encodedTerm}&hl=en-US&gl=US&ceid=US:en`;

      const feed = await parser.parseURL(url);

      const articles = (feed.items || []).slice(0, 10).map(item => {
        // Extract source from title (Google News format: "Article Title - Source Name")
        const titleParts = (item.title || '').split(' - ');
        const source = titleParts.length > 1 ? titleParts[titleParts.length - 1] : 'Unknown';
        const title = titleParts.length > 1 ? titleParts.slice(0, -1).join(' - ') : item.title;

        return {
          title: title,
          link: item.link,
          pubDate: item.pubDate,
          source: source,
          recencyWeight: calculateRecencyWeight(item.pubDate),
        };
      });

      // Calculate weighted article count (recent articles count more)
      const weightedCount = articles.reduce((sum, a) => sum + a.recencyWeight, 0);

      results.push({
        term,
        totalResults: articles.length,
        weightedCount,
        articles,
      });

      await sleep(300); // Rate limit between terms
    } catch (error) {
      console.error(`  Google News RSS error for "${term}": ${error.message}`);
      results.push({
        term,
        totalResults: 0,
        weightedCount: 0,
        articles: [],
        error: error.message,
      });
    }
  }

  return results;
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
 * Fetch Reddit posts via JSON API (FREE - no auth required)
 * Uses Reddit's public JSON API: https://www.reddit.com/search.json
 * Returns posts with scores, comments, and recency weighting
 */
async function fetchRedditPosts(searchTerms) {
  const results = [];

  for (const term of searchTerms.slice(0, 5)) { // Limit to 5 terms
    try {
      const encodedTerm = encodeURIComponent(term);
      const url = `https://www.reddit.com/search.json?q=${encodedTerm}&sort=relevance&t=week&limit=10`;

      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'TrendMonitor/1.0 (trend monitoring bot)',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Reddit API returned ${response.status}`);
      }

      const data = await response.json();
      const posts = (data.data?.children || []).map(child => {
        const post = child.data;
        return {
          title: post.title,
          url: `https://www.reddit.com${post.permalink}`,
          score: post.score || 0,
          num_comments: post.num_comments || 0,
          created_utc: post.created_utc,
          subreddit: post.subreddit,
          recencyWeight: calculateRecencyWeight(new Date(post.created_utc * 1000)),
        };
      });

      // Calculate weighted count (recent posts with high engagement count more)
      const weightedCount = posts.reduce((sum, p) => {
        const engagementMultiplier = Math.min(2, 1 + (p.score + p.num_comments) / 500);
        return sum + p.recencyWeight * engagementMultiplier;
      }, 0);

      results.push({
        term,
        totalResults: posts.length,
        weightedCount,
        posts,
      });

      await sleep(500); // Rate limit between terms (Reddit is stricter)
    } catch (error) {
      console.error(`  Reddit API error for "${term}": ${error.message}`);
      results.push({
        term,
        totalResults: 0,
        weightedCount: 0,
        posts: [],
        error: error.message,
      });
    }
  }

  return results;
}

/**
 * Fetch HackerNews stories via Algolia API (FREE, unlimited, no auth)
 * Endpoint: https://hn.algolia.com/api/v1/search?query={term}&tags=story
 * Returns recent stories with points, comments, and recency weighting
 */
async function fetchHackerNews(searchTerms) {
  const results = [];

  for (const term of searchTerms.slice(0, 5)) { // Limit to 5 terms
    try {
      const encodedTerm = encodeURIComponent(term);
      const url = `https://hn.algolia.com/api/v1/search?query=${encodedTerm}&tags=story`;

      const response = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
      });

      if (!response.ok) {
        throw new Error(`HackerNews API returned ${response.status}`);
      }

      const data = await response.json();
      const stories = (data.hits || []).slice(0, 10).map(hit => ({
        title: hit.title,
        url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        points: hit.points || 0,
        num_comments: hit.num_comments || 0,
        created_at: hit.created_at,
        recencyWeight: calculateRecencyWeight(hit.created_at),
      }));

      // Calculate weighted count (recent stories with high engagement count more)
      const weightedCount = stories.reduce((sum, s) => {
        const engagementMultiplier = Math.min(2, 1 + (s.points + s.num_comments) / 200);
        return sum + s.recencyWeight * engagementMultiplier;
      }, 0);

      results.push({
        term,
        totalResults: stories.length,
        weightedCount,
        stories,
      });

      await sleep(300); // Rate limit between terms
    } catch (error) {
      console.error(`  HackerNews API error for "${term}": ${error.message}`);
      results.push({
        term,
        totalResults: 0,
        weightedCount: 0,
        stories: [],
        error: error.message,
      });
    }
  }

  return results;
}

/**
 * Fetch from additional RSS feeds (BBC, Guardian)
 * All FREE - no API keys required
 */
async function fetchAdditionalNewsRSS(searchTerms) {
  const parser = new Parser({
    timeout: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendMonitor/1.0)' }
  });

  const feeds = [
    { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
    { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
  ];

  const allArticles = [];

  for (const feedConfig of feeds) {
    try {
      const feed = await parser.parseURL(feedConfig.url);

      const articles = (feed.items || []).map(item => ({
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        source: feedConfig.name,
        description: item.contentSnippet || '',
        recencyWeight: calculateRecencyWeight(item.pubDate),
      }));

      // Filter articles that match any search term
      const matchingArticles = articles.filter(article =>
        searchTerms.some(term => {
          const termLower = term.toLowerCase();
          return (article.title?.toLowerCase().includes(termLower) ||
                  article.description?.toLowerCase().includes(termLower));
        })
      );

      allArticles.push(...matchingArticles);
      await sleep(200);
    } catch (error) {
      console.error(`  RSS feed error for ${feedConfig.name}: ${error.message}`);
    }
  }

  const weightedCount = allArticles.reduce((sum, a) => sum + a.recencyWeight, 0);

  return {
    allMatchingArticles: allArticles,
    totalMatches: allArticles.length,
    weightedCount,
  };
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
function calculateCoherenceScore(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss) {
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

  // Google News RSS (free source)
  if (googleNewsRss && googleNewsRss.length > 0) {
    const totalArticles = googleNewsRss.reduce((sum, r) => sum + r.totalResults, 0);
    sourceSignals.push({
      source: 'googleNewsRss',
      hasSignal: totalArticles > 0,
      magnitude: totalArticles,
      termCoverage: googleNewsRss.filter(r => r.totalResults > 0).length / googleNewsRss.length,
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

  // Reddit (free source)
  if (reddit && reddit.length > 0) {
    const totalPosts = reddit.reduce((sum, r) => sum + r.totalResults, 0);
    sourceSignals.push({
      source: 'reddit',
      hasSignal: totalPosts > 0,
      magnitude: totalPosts,
      termCoverage: reddit.filter(r => r.totalResults > 0).length / reddit.length,
    });
  }

  // HackerNews (free source)
  if (hackerNews && hackerNews.length > 0) {
    const totalStories = hackerNews.reduce((sum, r) => sum + r.totalResults, 0);
    sourceSignals.push({
      source: 'hackerNews',
      hasSignal: totalStories > 0,
      magnitude: totalStories,
      termCoverage: hackerNews.filter(r => r.totalResults > 0).length / hackerNews.length,
    });
  }

  // Additional RSS (BBC, Guardian - free sources)
  if (additionalRss && additionalRss.totalMatches > 0) {
    sourceSignals.push({
      source: 'additionalRss',
      hasSignal: additionalRss.totalMatches > 0,
      magnitude: additionalRss.totalMatches,
      termCoverage: 1, // Already filtered for matching terms
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
function calculateConfidenceV2(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss, coherenceScore) {
  let baseConfidence = 0;
  let dataPoints = 0;
  const maxDataPoints = 7; // 7 possible sources (including Reddit, HackerNews, and Additional RSS)

  // Calculate weighted source contributions
  if (googleTrends && googleTrends.allTrends?.length > 0) {
    baseConfidence += SOURCE_WEIGHTS.googleTrends.reliability * SOURCE_WEIGHTS.googleTrends.weight;
    dataPoints++;
  }

  // Google News RSS (free source)
  if (googleNewsRss && googleNewsRss.length > 0) {
    const hasData = googleNewsRss.some(r => r.totalResults > 0);
    if (hasData) {
      baseConfidence += SOURCE_WEIGHTS.googleNewsRss.reliability * SOURCE_WEIGHTS.googleNewsRss.weight;
      dataPoints++;
    }
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

  // Reddit (FREE - public JSON API)
  if (reddit && reddit.length > 0) {
    const hasPosts = reddit.some(r => r.totalResults > 0);
    if (hasPosts) {
      baseConfidence += SOURCE_WEIGHTS.reddit.reliability * SOURCE_WEIGHTS.reddit.weight;
      dataPoints++;
    }
  }

  // HackerNews (FREE - Algolia API)
  if (hackerNews && hackerNews.length > 0) {
    const hasStories = hackerNews.some(r => r.totalResults > 0);
    if (hasStories) {
      baseConfidence += SOURCE_WEIGHTS.hackerNews.reliability * SOURCE_WEIGHTS.hackerNews.weight;
      dataPoints++;
    }
  }

  // Additional RSS (BBC, Guardian - FREE)
  if (additionalRss && additionalRss.totalMatches > 0) {
    baseConfidence += SOURCE_WEIGHTS.additionalRss.reliability * SOURCE_WEIGHTS.additionalRss.weight;
    dataPoints++;
  }

  // Apply multipliers (adjusted for 7 possible sources)
  const freshnessMultiplier = 0.4 + (0.6 * (dataPoints / maxDataPoints)); // 0.4 - 1.0
  const sampleSizeMultiplier = 0.3 + (0.7 * Math.min(1, dataPoints / maxDataPoints)); // 0.3 - 1.0
  const agreementMultiplier = 0.75 + (0.40 * (coherenceScore / 100)); // 0.75 - 1.15

  let confidence = baseConfidence * freshnessMultiplier * sampleSizeMultiplier * agreementMultiplier;

  // Clamp to valid range
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
function calculateTrendScoreV2(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss, monitorId) {
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

  // Google News RSS (free source)
  if (googleNewsRss && googleNewsRss.length > 0) {
    const totalArticles = googleNewsRss.reduce((sum, r) => sum + r.totalResults, 0);
    const gnScore = Math.min(100, (totalArticles / 30) * 100);
    authorityScore += SOURCE_WEIGHTS.googleNewsRss.reliability *
      SOURCE_WEIGHTS.googleNewsRss.weight * gnScore;
    totalWeight += SOURCE_WEIGHTS.googleNewsRss.weight;

    // Collect article summaries from Google News RSS
    for (const result of googleNewsRss) {
      for (const article of (result.articles || []).slice(0, 3)) {
        if (article.title) {
          articles.push(`- ${article.title} (${article.source || 'Google News'})`);
        }
      }
    }
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

  // Reddit (free source)
  if (reddit && reddit.length > 0) {
    const totalPosts = reddit.reduce((sum, r) => sum + r.totalResults, 0);
    const redditScore = Math.min(100, (totalPosts / 20) * 100);
    authorityScore += SOURCE_WEIGHTS.reddit.reliability *
      SOURCE_WEIGHTS.reddit.weight * redditScore;
    totalWeight += SOURCE_WEIGHTS.reddit.weight;

    // Collect Reddit post summaries
    for (const result of reddit) {
      for (const post of (result.posts || []).slice(0, 3)) {
        if (post.title) {
          articles.push(`- ${post.title} (Reddit r/${post.subreddit}: ${post.score} pts)`);
        }
      }
    }
  }

  // HackerNews (free source)
  if (hackerNews && hackerNews.length > 0) {
    const totalStories = hackerNews.reduce((sum, r) => sum + r.totalResults, 0);
    const hnScore = Math.min(100, (totalStories / 20) * 100);
    authorityScore += SOURCE_WEIGHTS.hackerNews.reliability *
      SOURCE_WEIGHTS.hackerNews.weight * hnScore;
    totalWeight += SOURCE_WEIGHTS.hackerNews.weight;

    // Collect HackerNews story summaries
    for (const result of hackerNews) {
      for (const story of (result.stories || []).slice(0, 3)) {
        if (story.title) {
          articles.push(`- ${story.title} (HackerNews: ${story.points} pts)`);
        }
      }
    }
  }

  // Additional RSS (BBC, Guardian - free sources)
  if (additionalRss && additionalRss.totalMatches > 0) {
    const rssScore = Math.min(100, (additionalRss.totalMatches / 10) * 100);
    authorityScore += SOURCE_WEIGHTS.additionalRss.reliability *
      SOURCE_WEIGHTS.additionalRss.weight * rssScore;
    totalWeight += SOURCE_WEIGHTS.additionalRss.weight;

    // Collect Additional RSS article summaries
    for (const article of (additionalRss.allMatchingArticles || []).slice(0, 3)) {
      if (article.title) {
        articles.push(`- ${article.title} (${article.source})`);
      }
    }
  }

  authorityScore = totalWeight > 0 ? authorityScore / totalWeight : 0;

  // === Factor 3: Recency (15%) - Article freshness weighted ===
  let recencyScore = 50; // Default baseline
  let recencySourceCount = 0;

  // Include Google News RSS in recency calculation
  if (googleNewsRss && googleNewsRss.length > 0) {
    const totalWeighted = googleNewsRss.reduce((sum, r) => sum + (r.weightedCount || 0), 0);
    const totalRaw = googleNewsRss.reduce((sum, r) => sum + r.totalResults, 0);
    if (totalRaw > 0) {
      recencyScore = Math.min(100, (totalWeighted / totalRaw) * 100);
      recencySourceCount++;
    }
  }

  if (newsData && newsData.length > 0) {
    const totalWeighted = newsData.reduce((sum, r) => sum + (r.weightedCount || 0), 0);
    const totalRaw = newsData.reduce((sum, r) => sum + r.totalResults, 0);
    if (totalRaw > 0) {
      const newsRecency = Math.min(100, (totalWeighted / totalRaw) * 100);
      recencyScore = recencySourceCount > 0 ? (recencyScore + newsRecency) / 2 : newsRecency;
      recencySourceCount++;
    }
  }

  if (serpResults && serpResults.length > 0) {
    const totalWeighted = serpResults.reduce((sum, r) => sum + (r.weightedCount || 0), 0);
    const totalRaw = serpResults.reduce((sum, r) => sum + r.totalResults, 0);
    if (totalRaw > 0) {
      const serpRecency = Math.min(100, (totalWeighted / totalRaw) * 100);
      recencyScore = recencySourceCount > 0 ? (recencyScore + serpRecency) / 2 : serpRecency;
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

  // === Factor 6: Sentiment (10%) - AFINN-based sentiment analysis ===
  // Collect article objects for sentiment analysis
  const articleObjectsForSentiment = [];

  // Collect from Google News RSS
  if (googleNewsRss && googleNewsRss.length > 0) {
    for (const result of googleNewsRss) {
      for (const article of (result.articles || [])) {
        if (article.title) {
          articleObjectsForSentiment.push({ title: article.title });
        }
      }
    }
  }

  // Collect from NewsData
  if (newsData && newsData.length > 0) {
    for (const result of newsData) {
      for (const article of (result.articles || [])) {
        if (article.title) {
          articleObjectsForSentiment.push({ title: article.title });
        }
      }
    }
  }

  // Collect from SerpAPI
  if (serpResults && serpResults.length > 0) {
    for (const result of serpResults) {
      for (const news of (result.newsResults || [])) {
        if (news.title) {
          articleObjectsForSentiment.push({ title: news.title });
        }
      }
    }
  }

  // Collect from Reddit
  if (reddit && reddit.length > 0) {
    for (const result of reddit) {
      for (const post of (result.posts || [])) {
        if (post.title) {
          articleObjectsForSentiment.push({ title: post.title });
        }
      }
    }
  }

  // Collect from HackerNews
  if (hackerNews && hackerNews.length > 0) {
    for (const result of hackerNews) {
      for (const story of (result.stories || [])) {
        if (story.title) {
          articleObjectsForSentiment.push({ title: story.title });
        }
      }
    }
  }

  // Collect from Additional RSS (BBC, Guardian)
  if (additionalRss && additionalRss.allMatchingArticles) {
    for (const article of additionalRss.allMatchingArticles) {
      if (article.title) {
        articleObjectsForSentiment.push({ title: article.title });
      }
    }
  }

  // Calculate sentiment using AFINN analysis
  const sentimentData = calculateArticleSentiment(articleObjectsForSentiment);
  const sentimentScore = sentimentData.score;

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
    (googleNewsRss?.length > 0 && googleNewsRss.some(r => r.totalResults > 0) ? 1 : 0) +
    (newsData?.length > 0 && newsData.some(r => r.totalResults > 0) ? 1 : 0) +
    (serpResults?.length > 0 && serpResults.some(r => r.totalResults > 0) ? 1 : 0) +
    (reddit?.length > 0 && reddit.some(r => r.totalResults > 0) ? 1 : 0) +
    (hackerNews?.length > 0 && hackerNews.some(r => r.totalResults > 0) ? 1 : 0) +
    (additionalRss && additionalRss.totalMatches > 0 ? 1 : 0);

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
  const [googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss] = await Promise.all([
    fetchGoogleTrendsRSS(monitor.terms), // Now fetches US, GB, CA, AU
    fetchGoogleNewsRSS(monitor.terms),   // FREE - no API key required
    fetchNewsVolume(monitor.terms),
    fetchGoogleNews(monitor.terms),
    fetchRedditPosts(monitor.terms),     // FREE - Reddit public JSON API
    fetchHackerNews(monitor.terms),      // FREE - HackerNews Algolia API
    fetchAdditionalNewsRSS(monitor.terms), // FREE - BBC, Guardian RSS
  ]);

  // Log region data
  if (googleTrends.regionData) {
    const regions = Object.entries(googleTrends.regionData)
      .map(([r, d]) => `${r}:${d.matches}`)
      .join(', ');
    console.log(`  Regions checked: ${regions}`);
  }

  // Log Google News RSS results
  const googleNewsRssArticleCount = googleNewsRss
    ? googleNewsRss.reduce((sum, r) => sum + r.totalResults, 0)
    : 0;
  if (googleNewsRssArticleCount > 0) {
    console.log(`  Google News RSS: ${googleNewsRssArticleCount} articles found`);
  }

  // Log Reddit results
  if (reddit && reddit.length > 0) {
    const totalRedditPosts = reddit.reduce((sum, r) => sum + r.totalResults, 0);
    console.log(`  Reddit: ${totalRedditPosts} posts found`);
  }

  // Log HackerNews results
  if (hackerNews && hackerNews.length > 0) {
    const totalHNStories = hackerNews.reduce((sum, r) => sum + r.totalResults, 0);
    console.log(`  HackerNews: ${totalHNStories} stories found`);
  }

  // Log Additional RSS results (BBC, Guardian)
  if (additionalRss && additionalRss.totalMatches > 0) {
    console.log(`  Additional RSS (BBC, Guardian): ${additionalRss.totalMatches} articles found`);
  }

  // Calculate Coherence Score first (needed for confidence)
  const coherenceData = calculateCoherenceScore(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss);
  console.log(`  Coherence: ${coherenceData.coherenceScore} (${coherenceData.coherenceLevel})`);

  // Calculate Trend Score v2 (with all 6 factors)
  const trendData = calculateTrendScoreV2(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss, monitor.monitorId);

  // Calculate Confidence v2 (uses coherence)
  const confidenceData = calculateConfidenceV2(googleTrends, googleNewsRss, newsData, serpResults, reddit, hackerNews, additionalRss, coherenceData.coherenceScore);

  // Calculate Trend Direction
  const previousScore = monitor.previousTrendScore || 50;
  const trendDirection = calculateTrendDirection(trendData.trendScore, previousScore, trendData.changePercent);

  // Collect article timestamps for momentum calculation
  const articleTimestamps = [];
  if (googleNewsRss) {
    for (const result of googleNewsRss) {
      for (const article of (result.articles || [])) {
        if (article.pubDate) articleTimestamps.push(article.pubDate);
      }
    }
  }
  if (additionalRss && additionalRss.allMatchingArticles) {
    for (const article of additionalRss.allMatchingArticles) {
      if (article.pubDate) articleTimestamps.push(article.pubDate);
    }
  }

  // Calculate Momentum Trend
  const momentumTrend = calculateMomentumTrend(googleTrends.regionData, articleTimestamps);

  console.log(`  Trend Score: ${trendData.trendScore} (raw: ${trendData.rawScore}, smoothed: ${trendData.smoothedScore})`);
  console.log(`  Change: ${trendData.changePercent}%`);
  console.log(`  Confidence: ${confidenceData.confidence}`);
  console.log(`  Data Sources: ${trendData.dataSourcesUsed}`);

  // Log factor breakdown if verbose
  if (process.env.VERBOSE === 'true') {
    console.log(`  Factors: V=${trendData.factors.velocity} M=${trendData.factors.momentum} S=${trendData.factors.sentiment} R=${trendData.factors.relevance} A=${trendData.factors.authority} Re=${trendData.factors.recency}`);
    console.log(`  Coherence Factors: Dir=${coherenceData.factors.directionAgreement} Mag=${coherenceData.factors.magnitudeConsistency} Temp=${coherenceData.factors.temporalConsistency} Term=${coherenceData.factors.termCorrelation}`);
  }

  // === Collect article context for storage ===

  // Collect top articles with URLs (prefer Google News RSS since it's free, then NewsData, then SerpAPI)
  const topArticles = [];
  const sourceUrls = new Set();

  // Collect from Google News RSS (FREE - prioritize this)
  if (googleNewsRss && googleNewsRss.length > 0) {
    for (const result of googleNewsRss) {
      for (const article of (result.articles || [])) {
        if (article.title && article.link) {
          topArticles.push({ title: article.title, url: article.link, source: 'Google News RSS' });
          sourceUrls.add(article.link);
        }
      }
    }
  }

  // Collect from NewsData
  if (newsData && newsData.length > 0) {
    for (const result of newsData) {
      for (const article of (result.articles || [])) {
        if (article.title && article.link) {
          topArticles.push({ title: article.title, url: article.link, source: 'NewsData' });
          sourceUrls.add(article.link);
        }
      }
    }
  }

  // Collect from SerpAPI (Google News)
  if (serpResults && serpResults.length > 0) {
    for (const result of serpResults) {
      for (const news of (result.newsResults || [])) {
        if (news.title && news.link) {
          topArticles.push({ title: news.title, url: news.link, source: 'SerpAPI' });
          sourceUrls.add(news.link);
        }
      }
    }
  }

  // Collect from Additional RSS (BBC, Guardian)
  if (additionalRss && additionalRss.allMatchingArticles) {
    for (const article of additionalRss.allMatchingArticles) {
      if (article.title && article.link) {
        topArticles.push({ title: article.title, url: article.link, source: article.source || 'Additional RSS' });
        sourceUrls.add(article.link);
      }
    }
  }

  // Apply deduplication to articles
  const deduplicationResult = deduplicateArticles(topArticles);
  const deduplicatedArticles = deduplicationResult.articles;

  // Log deduplication stats if any duplicates were removed
  if (deduplicationResult.originalCount > deduplicationResult.deduplicatedCount) {
    console.log(`  Deduplication: ${deduplicationResult.originalCount} -> ${deduplicationResult.deduplicatedCount} articles`);
  }

  // Format top 3 articles as markdown links (using deduplicated articles)
  const topArticlesFormatted = deduplicatedArticles
    .slice(0, 3)
    .map(a => `[${a.title}](${a.url})`)
    .join('\n');

  // Format regions data
  const regionsData = googleTrends.regionData
    ? Object.entries(googleTrends.regionData)
        .map(([region, data]) => `${region}:${data.matches}`)
        .join(', ')
    : '';

  // Build summary text
  const trendMatchCount = googleTrends.matchingTrends?.length || 0;
  const newsDataArticleCount = newsData
    ? newsData.reduce((sum, r) => sum + (r.articles?.length || 0), 0)
    : 0;
  const serpArticleCount = serpResults
    ? serpResults.reduce((sum, r) => sum + (r.newsResults?.length || 0), 0)
    : 0;

  const summaryParts = [];
  if (trendMatchCount > 0) {
    summaryParts.push(`Found ${trendMatchCount} matching trend${trendMatchCount > 1 ? 's' : ''} in Google Trends`);
  }
  if (googleNewsRssArticleCount > 0) {
    summaryParts.push(`${googleNewsRssArticleCount} article${googleNewsRssArticleCount > 1 ? 's' : ''} from Google News RSS`);
  }
  if (newsDataArticleCount > 0) {
    summaryParts.push(`${newsDataArticleCount} related article${newsDataArticleCount > 1 ? 's' : ''} from NewsData`);
  }
  if (serpArticleCount > 0) {
    summaryParts.push(`${serpArticleCount} article${serpArticleCount > 1 ? 's' : ''} from Google News (SerpAPI)`);
  }
  if (additionalRss && additionalRss.totalMatches > 0) {
    summaryParts.push(`${additionalRss.totalMatches} article${additionalRss.totalMatches > 1 ? 's' : ''} from BBC/Guardian`);
  }
  if (summaryParts.length === 0) {
    summaryParts.push('No matching trends or articles found');
  }
  const contextSummary = summaryParts.join('. ') + '.';

  // Generate action recommendations
  const rawRecommendations = generateActionRecommendations(
    trendData,
    { coherenceScore: coherenceData.coherenceScore, coherenceLevel: coherenceData.coherenceLevel },
    confidenceData,
    monitor
  );
  const prioritizedRecommendations = prioritizeRecommendations(rawRecommendations);

  // Format recommendations for storage
  const recommendationsText = prioritizedRecommendations
    .map(rec => rec.formattedText)
    .join('\n');

  // Get top recommendation for summary
  const topRecommendation = prioritizedRecommendations.length > 0
    ? prioritizedRecommendations[0].formattedText
    : 'No recommendations';

  return {
    ...trendData,
    coherenceScore: coherenceData.coherenceScore,
    coherenceLevel: coherenceData.coherenceLevel,
    coherenceFactors: coherenceData.factors,
    confidence: confidenceData.confidence,
    confidenceFactors: confidenceData.factors,
    summary: `${monitor.terms[0] || 'Unknown'}: Score ${trendData.trendScore} ${trendDirection.emoji}, Coherence ${coherenceData.coherenceScore} (${coherenceData.coherenceLevel}), Change ${trendData.changePercent}%. ${trendDirection.description}. Top action: ${topRecommendation}`,
    // New context properties
    topArticles: topArticlesFormatted,
    sourceUrls: Array.from(sourceUrls).slice(0, 10).join('\n'),
    regionsData,
    contextSummary,
    googleNewsRssArticleCount,
    // Action recommendations
    recommendations: recommendationsText,
    prioritizedRecommendations: prioritizedRecommendations,
    topRecommendation: topRecommendation,
    // Trend direction and momentum
    trendDirection: trendDirection,
    momentumTrend: momentumTrend,
    // Deduplication stats
    deduplication: {
      originalCount: deduplicationResult.originalCount,
      deduplicatedCount: deduplicationResult.deduplicatedCount,
    },
    // Additional RSS article count
    additionalRssArticleCount: additionalRss ? additionalRss.totalMatches : 0,
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
  console.log(`  - Google News RSS: Available (FREE - no API key required)`);
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

        // Update monitor properties in Notion
        const updated = await updateMonitor(monitor.pageId, trendData);
        if (updated) analyzed++;

        // Update monitor page content with rich blocks
        await updateMonitorContent(monitor.pageId, monitor, trendData);

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
