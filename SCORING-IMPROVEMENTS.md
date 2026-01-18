# Trend Monitor Scoring Improvements

## Executive Summary

Based on comprehensive multi-agent analysis, here are the improvements to increase trend score accuracy and introduce a coherence metric.

---

## Current State

| Metric | Formula | Range | Limitations |
|--------|---------|-------|-------------|
| **Trend Score** | Sum of article counts | 0-100 | No velocity, sentiment, or authority |
| **Confidence** | `0.5 + (sources × 0.15)` | 0.65-0.95 | Only counts sources, ignores quality |
| **Coherence** | N/A | N/A | Does not exist |

---

## New Metrics Overview

### 1. Trend Score v2 (6 Factors)

```
TrendScore = (
    0.20 × Velocity +      // Rate of change
    0.20 × Momentum +      // Sustained interest
    0.10 × Sentiment +     // Positive vs negative
    0.20 × Relevance +     // Term match quality
    0.15 × Authority +     // Source credibility
    0.15 × Recency         // Article freshness
) × DataQualityMultiplier
```

### 2. Confidence Score v2 (5 Factors)

```
Confidence = BaseConfidence × Multipliers

Where:
  BaseConfidence = Σ(SourceWeight × Reliability × DataQuality)

  Multipliers:
    × Freshness (0.4 - 1.0)
    × SampleSize (0.3 - 1.0)
    × Agreement (0.75 - 1.15)
    × HistoricalAccuracy (0.75 - 1.10)
```

### 3. Coherence Score (NEW - 4 Factors)

```
Coherence = (
    0.30 × DirectionAgreement +   // Do sources agree on up/down?
    0.25 × MagnitudeConsistency + // Similar signal strength?
    0.25 × TemporalConsistency +  // Sustained or spike?
    0.20 × TermCorrelation        // Related terms trending together?
) × 100
```

---

## Score Interpretation Guide

### Trend Score Levels
| Score | Level | Action |
|-------|-------|--------|
| 80-100 | Very High | Significant trend - investigate immediately |
| 60-79 | High | Above average - monitor closely |
| 40-59 | Moderate | Normal baseline coverage |
| 20-39 | Low | Below average interest |
| 0-19 | Very Low | Minimal/no coverage |

### Confidence Levels
| Score | Level | Meaning |
|-------|-------|---------|
| 0.85+ | High | Reliable data, safe to act |
| 0.65-0.84 | Moderate | Verify with additional sources |
| 0.50-0.64 | Low | Limited data, continue monitoring |
| <0.50 | Very Low | Insufficient data |

### Coherence Levels
| Score | Level | Action |
|-------|-------|--------|
| 75-100 | High | Signal is reliable - act on trend |
| 50-74 | Medium | Some consistency - verify first |
| 25-49 | Low | Weak signal - do not act |
| 0-24 | Noise | Disregard - likely false positive |

---

## New Free Data Sources to Add

### High Priority (Add First)
| Source | Free Tier | Best For |
|--------|-----------|----------|
| Wikipedia Pageviews API | Unlimited | Mainstream interest indicator |
| Reddit API | 60 req/min | Social sentiment, early trends |
| Hacker News API | Unlimited | Tech innovation signals |
| Cannabis RSS Feeds | Unlimited | Industry-specific news |

### Medium Priority
| Source | Free Tier | Best For |
|--------|-----------|----------|
| GNews API | 100/day | Global news coverage |
| Alpha Vantage | 25/day | Stock correlation |
| VADER (local) | Unlimited | Sentiment analysis |

---

## Implementation Phases

### Phase 1: Quick Wins (This Week)
1. Replace hardcoded `previousScore = 50` with stored history
2. Add multi-region Google Trends (US, GB, CA, AU)
3. Add article recency weighting (exponential decay)
4. Implement source reliability weights
5. Add score smoothing (EMA)

**Expected improvement: +40-50% accuracy**

### Phase 2: Free API Integration (Next Week)
1. Add Wikipedia Pageviews API
2. Add Reddit API for cannabis subreddits
3. Add Hacker News API
4. Add industry RSS feeds

**Expected improvement: +60% data coverage**

### Phase 3: Advanced Features (Later)
1. Historical trend database
2. Predictive scoring (linear regression)
3. Automated threshold tuning
4. Anomaly detection engine

---

## Quick Reference: Source Reliability Weights

| Source | Reliability | Weight |
|--------|-------------|--------|
| Google Trends RSS | 0.85 | 0.35 |
| NewsData.io | 0.80 | 0.35 |
| SerpAPI | 0.90 | 0.30 |
| Wikipedia | 0.95 | 0.25 |
| Reddit | 0.70 | 0.20 |
| Hacker News | 0.75 | 0.15 |

---

## How to Increase Your Scores

### To Increase Trend Score:
1. Add more data sources (Phase 2 APIs)
2. Use multi-region trend fetching
3. Add article recency weighting
4. Improve term matching (fuzzy match, synonyms)

### To Increase Confidence:
1. Add more active data sources
2. Improve data freshness (real-time vs cached)
3. Increase sample size (more articles)
4. Track historical accuracy and calibrate

### To Increase Coherence:
1. Wait for sources to agree (don't act on single-source signals)
2. Monitor for sustained trends (not spikes)
3. Add related terms to monitor for correlation
4. Ensure consistent signal magnitude across sources

---

## Files Modified

- `trend-monitor.js` - Main scoring functions
- `TREND-MONITOR-IMPROVEMENT-PLAN.md` - Detailed implementation guide
- `SCORING-IMPROVEMENTS.md` - This summary document
