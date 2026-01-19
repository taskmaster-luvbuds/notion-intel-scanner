# Maintenance Guide

This guide covers ongoing maintenance tasks for the Notion Intel Scanner to ensure reliable operation and optimal performance.

---

## Table of Contents

1. [Daily Checks](#daily-checks)
2. [Weekly Maintenance Tasks](#weekly-maintenance-tasks)
3. [Monthly Reviews](#monthly-reviews)
4. [Updating API Keys](#updating-api-keys)
5. [Adding New Monitors](#adding-new-monitors)
6. [Adjusting Source Weights](#adjusting-source-weights)
7. [Updating AFINN Word List](#updating-afinn-word-list)
8. [Performance Optimization Tips](#performance-optimization-tips)
9. [Database Cleanup](#database-cleanup)
10. [Log Rotation](#log-rotation)

---

## Daily Checks

### Automated Run Verification

1. **Check GitHub Actions status**
   - Navigate to repository Actions tab
   - Verify the daily scan completed successfully
   - Review any failed runs for error messages

2. **Notion Database Review**
   - Open your Signals database in Notion
   - Confirm new signals were created (if applicable)
   - Check for any duplicate entries

3. **Quick Health Checks**
   ```bash
   # Run a dry-run to test connectivity
   node trend-monitor.js --dry-run

   # Check for API errors in output
   node trend-monitor.js --verbose --dry-run
   ```

### Alert Response

- Review any alerts with "INVESTIGATE" recommendations immediately
- Acknowledge "MONITOR" alerts within 24 hours
- Archive stale signals that are no longer relevant

---

## Weekly Maintenance Tasks

### Source Health Audit

1. **Test each data source manually**
   ```bash
   # Enable verbose mode to see source-by-source results
   VERBOSE=true node trend-monitor.js --dry-run
   ```

2. **Check for API changes**
   - HackerNews Algolia API: Verify search endpoint responding
   - Reddit JSON API: Confirm no rate limiting issues
   - RSS feeds: Check feeds are still publishing

3. **Review Score Trends**
   - Look for monitors with consistently low scores
   - Identify monitors with erratic scoring (may need keyword adjustment)
   - Note any monitors that haven't triggered alerts in 2+ weeks

### Keyword Optimization

- Review which keywords are generating valuable signals
- Remove or replace underperforming keywords
- Add new keywords based on emerging topics

### Deduplication Review

- Check if legitimate signals are being filtered as duplicates
- Adjust Jaccard similarity threshold if needed (default: 0.6)
- Lower threshold = more aggressive deduplication
- Higher threshold = more permissive (may allow near-duplicates)

---

## Monthly Reviews

### Comprehensive Audit

1. **Source Reliability Assessment**
   - Review which sources provide highest-quality signals
   - Adjust source weights based on accuracy
   - Consider adding/removing sources

2. **Scoring Calibration**
   - Compare predicted urgency with actual importance
   - Adjust scoring weights if needed
   - Review coherence thresholds

3. **Monitor Cleanup**
   - Archive inactive monitors (no signals in 30+ days)
   - Consolidate similar monitors
   - Document any removed monitors and reasons

### Performance Metrics

Track and review:
- Average signals per day/week
- Signal accuracy rate (were alerts actionable?)
- Source uptime percentage
- API error rates

### Documentation Update

- Update README if configuration has changed
- Document any custom modifications
- Record lessons learned from false positives/negatives

---

## Updating API Keys

### When to Update

- API key compromised or leaked
- Key expiration (check provider policies)
- Switching to different API tier

### Update Process

1. **Generate new key from provider**
   - SerpAPI: https://serpapi.com/manage-api-key
   - Other providers: Check respective dashboards

2. **Update GitHub Secrets**
   ```
   Repository Settings > Secrets and variables > Actions
   Update: SERPAPI_KEY (or relevant secret)
   ```

3. **Update local .env file**
   ```bash
   # Edit .env with new key
   SERPAPI_KEY=your_new_api_key_here
   ```

4. **Test the update**
   ```bash
   node trend-monitor.js --dry-run
   ```

### API Key Security

- Never commit API keys to version control
- Rotate keys every 90 days (recommended)
- Use environment-specific keys (dev/prod)
- Monitor API usage for anomalies

---

## Adding New Monitors

### Step-by-Step Process

1. **Define monitor in Notion**
   - Create new entry in Monitors database
   - Set keywords (comma-separated)
   - Configure priority level
   - Set initial thresholds

2. **Test the new monitor**
   ```bash
   # Run with verbose to see new monitor results
   VERBOSE=true node trend-monitor.js --dry-run
   ```

3. **Calibrate thresholds**
   - Start with default thresholds
   - Adjust based on first week of signals
   - Lower threshold = more alerts
   - Higher threshold = fewer, more significant alerts

### Monitor Best Practices

- Use specific, targeted keywords (avoid generic terms)
- Include variations and synonyms
- Set appropriate priority based on topic importance
- Review new monitors weekly for first month

---

## Adjusting Source Weights

### Understanding Source Weights

Source weights determine how much each data source contributes to the overall score:

```javascript
const sourceReliability = {
  serpapi: 1.0,      // Highest reliability (paid API)
  google_trends: 0.9, // High reliability
  bbc_news: 0.85,    // Established news source
  guardian: 0.85,    // Established news source
  hackernews: 0.8,   // Tech community signals
  reddit: 0.7,       // Community discussions
  rss_general: 0.75  // Aggregated feeds
};
```

### When to Adjust

- Source consistently provides low-quality signals
- Source has changed content focus
- New source added with unknown reliability
- Industry/topic-specific weight adjustments needed

### Adjustment Process

1. **Edit trend-monitor.js**
   - Locate `sourceReliability` object
   - Adjust weights (0.0 - 1.0 scale)

2. **Test changes**
   ```bash
   node trend-monitor.js --dry-run --verbose
   ```

3. **Monitor impact**
   - Track signal quality for 1-2 weeks
   - Revert if quality decreases

---

## Updating AFINN Word List

### What is AFINN?

AFINN is a lexicon of English words rated for sentiment valence:
- Scale: -5 (very negative) to +5 (very positive)
- Used for sentiment analysis in trend scoring

### When to Update

- Domain-specific terms missing
- New slang or terminology emerged
- False sentiment classifications observed

### Update Process

1. **Locate sentiment.js**
   ```bash
   # The AFINN word list is in sentiment.js
   ```

2. **Add new words**
   ```javascript
   // Add to the AFINN object
   const AFINN = {
     // ... existing words ...
     'newterm': 3,    // Positive sentiment
     'badterm': -2,   // Negative sentiment
   };
   ```

3. **Test changes**
   ```bash
   # Run with test content
   node -e "const s = require('./sentiment.js'); console.log(s.analyze('your test text here'));"
   ```

### Custom Domain Vocabularies

For industry-specific monitoring, consider:
- Adding industry jargon with appropriate scores
- Adjusting scores for domain context
- Creating separate word lists for different monitors

---

## Performance Optimization Tips

### Speed Improvements

1. **Reduce timeout values** (if sources are fast)
   ```javascript
   const FETCH_TIMEOUT = 8000; // Reduce from 10000
   ```

2. **Limit concurrent requests**
   ```javascript
   // Process sources in smaller batches
   const BATCH_SIZE = 3;
   ```

3. **Cache frequently accessed data**
   - Consider caching RSS feeds for 1 hour
   - Cache Google Trends results

### Memory Optimization

1. **Limit article storage**
   - Keep only recent articles (last 7 days)
   - Truncate long content strings

2. **Clean up score history**
   - Maintain only last 30 days of history
   - Archive older data if needed

### API Rate Limiting

- Implement exponential backoff for retries
- Respect rate limits (especially Reddit)
- Space out requests during execution

---

## Database Cleanup

### Notion Database Maintenance

1. **Archive old signals**
   - Create archived view for signals older than 90 days
   - Move to archive database quarterly

2. **Remove duplicates**
   - Run deduplication check monthly
   - Merge similar signals manually if needed

3. **Update stale monitors**
   - Mark inactive monitors as archived
   - Update keywords for evolving topics

### Local Data Cleanup

```bash
# Remove old log files (if any)
rm -f *.log

# Clear any temp files
rm -f *.tmp

# Reset score history (if needed)
# Edit trend-monitor.js to clear scoreHistory object
```

---

## Log Rotation

### Setting Up Log Rotation

If you're capturing logs to files, implement rotation:

1. **Using logrotate (Linux/Mac)**
   ```bash
   # Create /etc/logrotate.d/notion-intel-scanner
   /path/to/logs/*.log {
       daily
       rotate 7
       compress
       missingok
       notifempty
   }
   ```

2. **Manual rotation script**
   ```bash
   #!/bin/bash
   LOG_DIR="/path/to/logs"
   MAX_LOGS=7

   # Rotate logs
   cd $LOG_DIR
   for i in $(seq $((MAX_LOGS-1)) -1 1); do
       [ -f "scanner.$i.log" ] && mv "scanner.$i.log" "scanner.$((i+1)).log"
   done
   [ -f "scanner.log" ] && mv "scanner.log" "scanner.1.log"
   ```

### GitHub Actions Logs

- GitHub automatically retains workflow logs for 90 days
- Download important logs before expiration
- Use workflow artifacts for long-term storage

### Log Analysis

Regularly review logs for:
- Recurring errors
- API timeouts
- Rate limiting issues
- Unexpected behavior patterns

---

## Troubleshooting Quick Reference

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| No signals created | All scores below threshold | Lower threshold or add keywords |
| Too many signals | Threshold too low | Raise threshold |
| API timeouts | Network issues or rate limiting | Add retry logic, check connectivity |
| Duplicate signals | Dedup threshold too high | Lower Jaccard threshold |
| Stale data | RSS feeds not updating | Check feed URLs, add backup sources |
| Notion errors | API token expired | Regenerate and update token |

---

## Contact and Support

For issues not covered in this guide:
- Review GitHub Issues for similar problems
- Check the main README for configuration help
- Review CHANGELOG for recent changes that may affect behavior
