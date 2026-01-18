# Changelog

All notable changes to the Notion Intel Scanner project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2025-01-18

### Added - Trend Monitor v2 Scoring System

#### New Metrics
- **Coherence Score (0-100)**: Measures signal reliability across sources
  - Direction Agreement (30%): Do sources agree on trend direction?
  - Magnitude Consistency (25%): Similar signal strength across sources?
  - Temporal Consistency (25%): Sustained trend or spike?
  - Term Correlation (20%): Related terms trending together?

- **Trend Score v2**: Multi-factor scoring system
  - Velocity (20%): Rate of change from previous score
  - Momentum (20%): Sustained interest across regions
  - Sentiment (10%): Positive vs negative signal (baseline)
  - Relevance (20%): Term match quality in trending topics
  - Authority (15%): Source credibility weighted
  - Recency (15%): Article freshness weighted

- **Confidence v2**: Source-weighted confidence calculation
  - Freshness multiplier (0.4 - 1.0)
  - Sample size multiplier (0.3 - 1.0)
  - Agreement multiplier (0.75 - 1.15)

#### Data Source Enhancements
- Multi-region Google Trends (US, GB, CA, AU)
- Article recency weighting with exponential decay (3-day half-life)
- Source reliability weights configuration

#### Technical Improvements
- EMA score smoothing (30% new, 70% historical)
- Score history tracking per monitor
- Enhanced alert creation with factor breakdowns
- VERBOSE mode for detailed logging

### Changed
- Trend alerts now include coherence level and factor breakdown
- Confidence calculation now uses source reliability weights
- Google Trends now checks 4 regions instead of 1

### Documentation
- Added SCORING-IMPROVEMENTS.md summary
- Added TREND-MONITOR-IMPROVEMENT-PLAN.md detailed guide
- Added CHANGELOG.md

## [1.1.0] - 2025-01-18

### Fixed
- Google Trends RSS URL corrected (was returning 404)
- Scoring normalization formula fixed (was inverted)
- Added missing `isValidUrl()` helper function
- Moved rss-parser import to top-level
- Added `fetchWithTimeout()` with 10s timeout using AbortController
- Added `alertExistsToday()` for duplicate alert detection

### Added
- SIGNALS_DATABASE_ID warning at startup if not configured
- Try/catch error handling for updateMonitor and createAlert
- Content length validation for alerts

### Changed
- Improved GitHub workflow secret validation
- Better error messages and logging

## [1.0.0] - 2025-01-17

### Added
- Initial release of Notion Intel Scanner
- Daily RSS feed scanning with configurable keywords
- Notion integration for creating signals
- SerpAPI integration for Google News (optional)
- GitHub Actions workflow for automated scanning
- Dry-run mode for testing

### Features
- Automated daily news scanning
- Configurable RSS feeds and keywords
- Notion signal creation with metadata
- Failure notification via GitHub Issues

---

## Roadmap (Planned)

### Phase 2: Free API Integration
- [ ] Wikipedia Pageviews API
- [ ] Reddit API for subreddit monitoring
- [ ] Hacker News API
- [ ] Industry RSS feeds

### Phase 3: Advanced Features
- [ ] Historical trend database
- [ ] Predictive scoring (linear regression)
- [ ] Automated threshold tuning
- [ ] Anomaly detection engine
