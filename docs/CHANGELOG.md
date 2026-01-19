# Changelog - Version 2.0.0 Multi-Source Trend Analysis

All notable changes for the Version 2.0.0 release focused on multi-source trend analysis.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] - Multi-Source Trend Analysis

This major release introduces comprehensive multi-source intelligence gathering with advanced sentiment analysis, deduplication, and trend prediction capabilities.

### New Features

#### AFINN Sentiment Analysis
- Integrated AFINN-165 word list for lexicon-based sentiment scoring
- Calculates sentiment scores from -5 (very negative) to +5 (very positive)
- Normalizes sentiment to 0-100 scale for consistency with other metrics
- Handles negation detection for improved accuracy
- Supports compound word analysis

#### HackerNews Algolia API Integration
- Real-time search via Algolia's HackerNews API
- Fetches stories, comments, and discussions
- Extracts engagement metrics (points, comments)
- Filters by relevance and recency
- No API key required - uses public endpoints

#### Reddit JSON API Integration
- Fetches trending posts from relevant subreddits
- Monitors technology, news, and industry-specific subreddits
- Extracts upvote counts and comment engagement
- Supports custom subreddit configuration
- Rate-limited to respect Reddit's API guidelines

#### Additional RSS Feeds
- **BBC News**: World, Technology, and Business feeds
- **The Guardian**: World news and technology coverage
- Expanded coverage for better signal detection
- Configurable feed weights for source prioritization

#### Article Deduplication with Jaccard Similarity
- Prevents duplicate signals from appearing in alerts
- Uses Jaccard similarity coefficient for fuzzy matching
- Configurable similarity threshold (default: 0.6)
- Compares article titles and content snippets
- Maintains clean, actionable intelligence output

#### Trend Direction Indicators with Emojis
- Visual indicators for trend direction:
  - Rising trend
  - Falling trend
  - Stable/neutral trend
  - New/emerging signal
- Improves at-a-glance trend assessment in Notion

#### Momentum Trend Calculation
- Tracks trend velocity over time
- Calculates rolling momentum across multiple time windows
- Identifies accelerating vs decelerating trends
- Weights recent data more heavily using EMA
- Provides early warning for trend reversals

#### Action Recommendations Engine
- Automated recommendations based on signal analysis:
  - **INVESTIGATE**: High-confidence emerging signals
  - **MONITOR**: Moderate signals requiring attention
  - **WATCH**: Low-priority but notable signals
  - **ARCHIVE**: Declining or stale signals
- Recommendations include reasoning and suggested next steps

#### Enhanced Coherence Scoring (7 Sources)
- Expanded from 4 to 7 source types for coherence calculation
- Sources now include:
  1. Google Trends (multi-region)
  2. RSS Feeds (news outlets)
  3. HackerNews discussions
  4. Reddit communities
  5. BBC News
  6. The Guardian
  7. SerpAPI (optional)
- Higher coherence = signals validated across multiple platforms

#### Enhanced Confidence Calculation
- Multi-factor confidence scoring:
  - Source agreement multiplier (0.75 - 1.15)
  - Freshness decay multiplier (0.4 - 1.0)
  - Sample size multiplier (0.3 - 1.0)
  - Coherence bonus (up to 20%)
- Confidence levels: Low (<40), Medium (40-70), High (>70)

#### EMA Smoothing for Score Stability
- Exponential Moving Average applied to all scores
- Smoothing factor: 30% new value, 70% historical
- Reduces noise from daily fluctuations
- Maintains trend direction while dampening spikes
- Prevents alert fatigue from score volatility

---

### Technical Changes

- Refactored data fetching into modular source handlers
- Added timeout handling for all external API calls (10s default)
- Improved error recovery and graceful degradation
- Enhanced logging with VERBOSE mode support
- Score history tracking per monitor for trend analysis

### Configuration Updates

- New environment variables for source API keys
- Configurable source weights in `sourceReliability` object
- Adjustable deduplication threshold
- Customizable subreddit list for Reddit monitoring

### Dependencies

- No new npm dependencies required
- All APIs use native fetch or included libraries
- AFINN word list embedded for offline operation

---

## Migration Notes

When upgrading from 1.x to 2.0.0:

1. Review new environment variables in `.env.example`
2. Existing monitors will automatically use new scoring
3. Historical scores will start fresh (no EMA history)
4. First run may show higher volatility until EMA stabilizes

---

## Related Documentation

- [MAINTENANCE.md](./MAINTENANCE.md) - Ongoing maintenance guide
- [../SCORING-IMPROVEMENTS.md](../SCORING-IMPROVEMENTS.md) - Detailed scoring methodology
- [../TREND-MONITOR-IMPROVEMENT-PLAN.md](../TREND-MONITOR-IMPROVEMENT-PLAN.md) - Full improvement roadmap
