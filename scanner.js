#!/usr/bin/env node
/**
 * Notion Intel Scanner
 *
 * Automated daily news scanner for cannabis accessories business intelligence.
 * Monitors RSS feeds and creates Notion signals for relevant articles.
 *
 * Designed to run via GitHub Actions (free for public repos).
 *
 * Required environment variables:
 *   NOTION_TOKEN - Notion API integration token
 *   SIGNALS_DATABASE_ID - Notion database ID for signals
 *
 * Optional:
 *   SERPAPI_KEY - SerpAPI key for Google News (100 free searches/month)
 *   DRY_RUN - Set to 'true' to test without creating signals
 */

const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');

// Initialize clients
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const rssParser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; NotionIntelScanner/1.0)'
  }
});

// Configuration
const SIGNALS_DB = process.env.SIGNALS_DATABASE_ID;
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

// ============================================================================
// RSS FEEDS - Cannabis & Accessories Industry News
// ============================================================================
const RSS_FEEDS = [
  // Cannabis Industry
  { name: 'MJBizDaily', url: 'https://mjbizdaily.com/feed/', category: 'cannabis' },
  { name: 'Marijuana Moment', url: 'https://www.marijuanamoment.net/feed/', category: 'legal' },
  { name: 'Hemp Industry Daily', url: 'https://hempindustrydaily.com/feed/', category: 'hemp' },
  { name: 'Leafly News', url: 'https://www.leafly.com/feed', category: 'cannabis' },
  { name: 'High Times', url: 'https://hightimes.com/feed/', category: 'cannabis' },
  { name: 'Cannabis Industry Journal', url: 'https://cannabisindustryjournal.com/feed/', category: 'cannabis' },

  // Trade & Tariffs
  { name: 'CBP Trade', url: 'https://www.cbp.gov/rss/trade', category: 'trade' },
  { name: 'CBP Forced Labor', url: 'https://www.cbp.gov/rss/trade/forced-labor', category: 'trade' },
  { name: 'JOC Trade', url: 'https://www.joc.com/api/rssfeed/8880', category: 'trade' },

  // Regulation
  { name: 'Tobacco Reporter', url: 'https://tobaccoreporter.com/feed/', category: 'regulation' },

  // Supply Chain
  { name: 'FreightWaves', url: 'https://www.freightwaves.com/feed', category: 'supply_chain' },
  { name: 'JOC Supply Chain', url: 'https://www.joc.com/api/rssfeed/24517', category: 'supply_chain' },
  { name: 'JOC Trans-Pacific', url: 'https://www.joc.com/api/rssfeed/24521', category: 'supply_chain' },
  { name: 'JOC Container Shipping', url: 'https://www.joc.com/api/rssfeed/24515', category: 'supply_chain' },
  { name: 'SCMP China', url: 'https://www.scmp.com/rss/4/feed', category: 'supply_chain' },
];

// ============================================================================
// MONITOR KEYWORDS - What to watch for
// ============================================================================
const MONITOR_KEYWORDS = {
  // Competitors
  competitors: [
    'puffco', 'greenlane', 'got vape', 'gotvape',
    'raw papers', 'hbi international', 'raw rolling',
    'yocan', 'ccell', 'jupiter research',
    'smoke cartel', 'dankstop', 'everything for 420',
    'mikes worldwide', 'mwi wholesale',
    'storz bickel', 'davinci', 'pax labs',
    'pulsar', 'lookah', 'hamilton devices', 'ispire', 'airistech',
    'gpen', 'g pen', 'grenco science', 'dr dabber', 'focus v',
    'mj arsenal', 'higher standards', 'ooze', 'kind pen', 'eyce',
    'grav labs', 'empire glassworks', 'vessel vape', 'genius pipe',
  ],

  // Regulations & Legal
  regulations: [
    'pmta', 'fda vape', 'fda enforcement', 'fda seizure',
    'pact act', 'safe banking', 'safer banking',
    '280e', 'cannabis tax', 'marijuana tax',
    'cannabis rescheduling', 'schedule iii', 'dea cannabis',
    'state cannabis law', 'legalization bill',
    'vape ban', 'flavored vape', 'disposable vape ban',
    'premarket tobacco', 'substantial equivalence', 'marketing denial order',
    'mdo', 'warning letter fda', 'import alert', 'synthetic nicotine',
    'delta 8 ban', 'delta 8 thc', 'flavor ban', 'menthol ban',
    'state vape law', 'mail ban vape', 'usps vape ban', 'tobacco 21',
  ],

  // Tariffs & Trade
  tariffs: [
    'china tariff', 'section 301', 'import duty', 'trade war',
    'tariff increase', 'tariff exemption', 'tariff exclusion',
    'customs enforcement', 'cbp seizure',
    'uflpa', 'forced labor', 'xinjiang',
    'fentanyl tariff', 'reciprocal tariff',
    'hts code', 'harmonized tariff', 'section 232',
    'antidumping duty', 'countervailing duty', 'de minimis',
    'section 321', 'entity list', 'china manufacturing',
    'nearshoring', 'friendshoring', 'cbp hold', 'customs hold',
  ],

  // Supply Chain
  supply_chain: [
    'shenzhen', 'cangzhou', 'yiwu', 'guangzhou',
    'chinese new year shipping', 'cny factory',
    'port congestion', 'shipping delay', 'container rate',
    'ocean freight', 'supply chain disruption',
    'vietnam manufacturing', 'india manufacturing',
    'dongguan', 'ningbo', 'foshan', 'freight rate', 'air freight',
    'red sea shipping', 'suez canal', 'panama canal', 'port strike',
    'factory closure', 'golden week', 'quality control china',
    'factory audit', 'supplier diversification',
  ],

  // Trade Shows
  trade_shows: [
    'mjbizcon', 'champs trade show', 'hall of flowers',
    'tpe total product expo', 'canton fair',
    'tobacco plus expo', 'cannabis conference',
    'indo expo', 'spannabis', 'necann', 'emerald cup',
    'cannabis cup', 'lift expo', 'vape expo', 'smoke shop expo',
  ],

  // Market & Business
  market: [
    'dispensary opening', 'dispensary closing', 'dispensary bankruptcy',
    'cannabis sales record', 'cannabis revenue',
    'vape market', 'accessories market',
    'smoke shop', 'head shop',
    'wholesale cannabis', 'cannabis distribution',
  ],

  // Compliance
  compliance: [
    'prop 65', 'proposition 65', 'california warning',
    'cpsc recall', 'product safety',
    'lab testing', 'heavy metals', 'pesticide',
  ],

  // Banking & Payments
  banking_payments: [
    'cannabis banking', 'marijuana banking', 'cannabis credit card',
    'cashless cannabis', 'payment processing cannabis', 'high risk merchant',
    'debanking', 'bank account closure', 'safe banking', 'safer banking',
  ],

  // Technology
  technology: [
    'cannabis ecommerce', 'online smoke shop', 'online head shop',
    'weedmaps', 'dutchie', 'jane technologies', 'cannabis pos',
    'flowhub', 'treez',
  ],

  // Mergers & Acquisitions
  mergers_acquisitions: [
    'cannabis acquisition', 'cannabis merger', 'dispensary acquisition',
    'cannabis consolidation', 'mso expansion', 'cannabis ipo',
    'cannabis funding', 'greenlane merger', 'distributor acquisition',
  ],
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Sleep helper
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
 * Wrapper for Notion API calls with exponential backoff for rate limiting
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
 * Fetch and parse RSS feeds
 */
async function fetchRSSFeeds() {
  const articles = [];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const feed of RSS_FEEDS) {
    try {
      console.log(`  Fetching ${feed.name}...`);
      const parsed = await rssParser.parseURL(feed.url);

      for (const item of parsed.items || []) {
        const pubDate = new Date(item.pubDate || item.isoDate || Date.now());

        // Only get articles from last 24 hours
        if (pubDate > yesterday) {
          articles.push({
            title: item.title || 'No title',
            link: item.link || '',
            content: (item.contentSnippet || item.content || '').substring(0, 2000),
            source: feed.name,
            category: feed.category,
            pubDate: pubDate,
          });
        }
      }

      // Small delay between feeds
      await sleep(500);
    } catch (error) {
      console.error(`  Warning: Error fetching ${feed.name}: ${error.message}`);
    }
  }

  return articles;
}

/**
 * Fetch Google News via SerpAPI (optional)
 */
async function fetchGoogleNews() {
  if (!process.env.SERPAPI_KEY) {
    return [];
  }

  const articles = [];
  const searches = [
    'cannabis accessories wholesale',
    'vape PMTA FDA enforcement',
    'china tariff smoking accessories',
  ];

  console.log('  Fetching Google News via SerpAPI...');

  for (const query of searches) {
    try {
      // NOTE: SerpAPI requires API key in URL query parameter; header auth not supported.
      // Consider using a server-side proxy in production to avoid exposing the key in logs.
      const url = `https://serpapi.com/search.json?engine=google_news&q=${encodeURIComponent(query)}&api_key=${process.env.SERPAPI_KEY}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`SerpAPI returned status ${response.status}`);
      }
      const data = await response.json();

      for (const item of data.news_results || []) {
        const itemLink = item.link || '';

        // Skip items with invalid URLs
        if (itemLink && !isValidUrl(itemLink)) {
          continue;
        }

        articles.push({
          title: item.title,
          link: itemLink,
          content: item.snippet || '',
          source: item.source?.name || 'Google News',
          category: 'google',
          pubDate: new Date(),
        });
      }

      await sleep(1000); // Rate limit SerpAPI
    } catch (error) {
      console.error(`  SerpAPI error for "${query}": ${error.message}`);
    }
  }

  return articles;
}

/**
 * Match articles against keywords
 */
function matchArticles(articles) {
  const matched = [];
  const seen = new Set();

  for (const article of articles) {
    // Skip if we've already matched this article
    if (seen.has(article.link)) continue;

    const text = `${article.title} ${article.content}`.toLowerCase();

    for (const [category, keywords] of Object.entries(MONITOR_KEYWORDS)) {
      for (const keyword of keywords) {
        if (text.includes(keyword.toLowerCase())) {
          matched.push({
            ...article,
            matchedKeyword: keyword,
            matchCategory: category,
            signalType: getSignalType(category),
          });
          seen.add(article.link);
          break; // Only match once per article per category
        }
      }
    }
  }

  return matched;
}

/**
 * Map category to Notion signal type
 */
function getSignalType(category) {
  const mapping = {
    competitors: 'NEWS',
    regulations: 'LEGAL',
    tariffs: 'LEGAL',
    supply_chain: 'NEWS',
    trade_shows: 'NEWS',
    market: 'FUNDING',
    compliance: 'LEGAL',
    banking_payments: 'LEGAL',
    technology: 'NEWS',
    mergers_acquisitions: 'FUNDING',
  };
  return mapping[category] || 'NEWS';
}

/**
 * Check if signal already exists in Notion (improved duplicate detection)
 */
async function signalExists(link) {
  if (!link) return true; // Conservative: skip if no link

  try {
    // Check by source property (contains the URL)
    const response = await notionRequest(() => notion.databases.query({
      database_id: SIGNALS_DB,
      filter: {
        property: 'source',
        rich_text: { contains: link.substring(0, 100) }
      },
      page_size: 1
    }));
    return response.results.length > 0;
  } catch (error) {
    // On error, return true (conservative - skip rather than create duplicate)
    console.error(`  Warning: Error checking for duplicate, skipping: ${error.message}`);
    return true;
  }
}

/**
 * Create signal in Notion (single API call with children blocks)
 */
async function createSignal(article) {
  const signalId = `auto-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  // Safe date validation
  const timestamp = article.pubDate instanceof Date && !isNaN(article.pubDate)
    ? article.pubDate.toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  try {
    // Create the page with children blocks in a single API call
    await notionRequest(() => notion.pages.create({
      parent: { database_id: SIGNALS_DB },
      icon: { type: 'emoji', emoji: '📰' },
      properties: {
        'signal_id': { title: [{ text: { content: signalId } }] },
        'entity': { rich_text: [{ text: { content: article.matchedKeyword.substring(0, 100) } }] },
        'signal_type': { select: { name: article.signalType } },
        'content': { rich_text: [{ text: { content: article.title.substring(0, 2000) } }] },
        'source': { rich_text: [{ text: { content: article.link.substring(0, 2000) } }] },
        'confidence': { number: 0.7 },
        'timestamp': { date: { start: timestamp } },
        'processed': { checkbox: false },
      },
      children: [
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: '📰 Auto-Detected Signal' } }] }
        },
        {
          type: 'callout',
          callout: {
            icon: { type: 'emoji', emoji: '🤖' },
            rich_text: [{ text: { content: 'This signal was automatically created by the Intel Scanner' } }]
          }
        },
        {
          type: 'heading_3',
          heading_3: { rich_text: [{ text: { content: 'Article Details' } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Source: ${article.source}` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Category: ${article.matchCategory}` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Matched Keyword: "${article.matchedKeyword}"` } }] }
        },
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: `Published: ${timestamp}` } }] }
        },
        {
          type: 'heading_3',
          heading_3: { rich_text: [{ text: { content: 'Summary' } }] }
        },
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: article.content || 'See source link for full article.' } }] }
        },
        {
          type: 'divider',
          divider: {}
        },
        {
          type: 'paragraph',
          paragraph: {
            rich_text: [{
              text: { content: 'Read full article', link: { url: article.link } }
            }]
          }
        },
      ]
    }));

    return true;
  } catch (error) {
    console.error(`  Warning: Error creating signal: ${error.message}`);
    return false;
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           NOTION INTEL SCANNER                             ║');
  console.log('║           Cannabis Accessories Business Intelligence       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Started: ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('Mode: DRY RUN (no signals will be created)');
  console.log('');

  // Validate environment
  if (!process.env.NOTION_TOKEN) {
    console.error('Error: NOTION_TOKEN environment variable not set');
    process.exit(1);
  }
  if (!SIGNALS_DB) {
    console.error('Error: SIGNALS_DATABASE_ID environment variable not set');
    process.exit(1);
  }

  try {
    // Test Notion connection
    console.log('Testing Notion connection...');
    await notionRequest(() => notion.databases.retrieve({ database_id: SIGNALS_DB }));
    console.log('Notion connection successful');
    console.log('');

    // Step 1: Fetch RSS feeds
    console.log('Step 1: Fetching RSS feeds...');
    const rssArticles = await fetchRSSFeeds();
    console.log(`  Found ${rssArticles.length} articles from RSS feeds`);
    console.log('');

    // Step 2: Fetch Google News (if API key available)
    console.log('Step 2: Fetching Google News...');
    const googleArticles = await fetchGoogleNews();
    console.log(`  Found ${googleArticles.length} articles from Google News`);
    console.log('');

    // Step 3: Match against keywords
    console.log('Step 3: Matching articles against keywords...');
    const allArticles = [...rssArticles, ...googleArticles];
    const matched = matchArticles(allArticles);
    console.log(`  Matched ${matched.length} articles to keywords`);
    console.log('');

    // Step 4: Create signals
    console.log('Step 4: Creating Notion signals...');
    let created = 0;
    let skipped = 0;
    let duplicates = 0;

    for (const article of matched) {
      // Check for duplicates
      const exists = await signalExists(article.link);
      if (exists) {
        duplicates++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would create: ${article.title.substring(0, 60)}...`);
        skipped++;
      } else {
        const success = await createSignal(article);
        if (success) {
          console.log(`  Created: ${article.title.substring(0, 60)}...`);
          created++;
        }
      }

      await sleep(300); // Rate limit
    }

    // Summary
    console.log('');
    console.log('════════════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`Total articles scanned:  ${allArticles.length}`);
    console.log(`Articles matched:        ${matched.length}`);
    console.log(`Signals created:         ${created}`);
    console.log(`Duplicates skipped:      ${duplicates}`);
    if (DRY_RUN) console.log(`Would create (dry run):  ${skipped}`);
    console.log(`Completed:               ${new Date().toISOString()}`);
    console.log('');

    // Exit with appropriate code
    process.exit(0);

  } catch (error) {
    console.error('');
    console.error('Fatal error:', error.message);
    console.error('');
    process.exit(1);
  }
}

main();
