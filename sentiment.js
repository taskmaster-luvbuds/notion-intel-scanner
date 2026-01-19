/**
 * AFINN Sentiment Analysis Module
 *
 * Provides basic sentiment analysis using the AFINN-111 word list.
 * Returns normalized scores (0-100, where 50 = neutral).
 */

/**
 * AFINN-111 word list - common sentiment words with scores from -5 to +5
 * Subset of ~200 most common words for efficiency
 */
const AFINN_WORDS = {
  // Strongly positive (+4 to +5)
  'outstanding': 5, 'superb': 5, 'breathtaking': 5, 'thrilled': 5,
  'excellent': 4, 'amazing': 4, 'awesome': 4, 'fantastic': 4, 'incredible': 4,
  'wonderful': 4, 'brilliant': 4, 'exceptional': 4, 'love': 4, 'loved': 4,

  // Positive (+2 to +3)
  'great': 3, 'good': 3, 'best': 3, 'happy': 3, 'success': 3, 'successful': 3,
  'win': 3, 'winner': 3, 'winning': 3, 'perfect': 3, 'beautiful': 3,
  'exciting': 3, 'excited': 3, 'impressive': 3, 'remarkable': 3,
  'positive': 2, 'nice': 2, 'helpful': 2, 'useful': 2, 'easy': 2,
  'improve': 2, 'improved': 2, 'improvement': 2, 'benefit': 2, 'benefits': 2,
  'effective': 2, 'efficient': 2, 'growth': 2, 'growing': 2, 'gains': 2,
  'boost': 2, 'boosted': 2, 'strong': 2, 'stronger': 2, 'recover': 2,
  'recovery': 2, 'stable': 2, 'steady': 2, 'secure': 2, 'safe': 2,
  'opportunity': 2, 'opportunities': 2, 'promising': 2, 'progress': 2,
  'advance': 2, 'advanced': 2, 'innovation': 2, 'innovative': 2,

  // Slightly positive (+1)
  'ok': 1, 'okay': 1, 'fine': 1, 'interesting': 1, 'like': 1,
  'support': 1, 'supported': 1, 'agree': 1, 'agreed': 1, 'calm': 1,
  'clear': 1, 'confident': 1, 'correct': 1, 'fair': 1,

  // Slightly negative (-1)
  'concern': -1, 'concerns': -1, 'concerned': -1, 'difficult': -1,
  'issue': -1, 'issues': -1, 'problem': -1, 'problems': -1,
  'question': -1, 'questions': -1, 'risk': -1, 'risks': -1, 'risky': -1,
  'slow': -1, 'slower': -1, 'uncertain': -1, 'uncertainty': -1,
  'unclear': -1, 'unknown': -1, 'weak': -1, 'weaker': -1,
  'decline': -1, 'declining': -1, 'drop': -1, 'dropped': -1,

  // Negative (-2 to -3)
  'bad': -3, 'worse': -3, 'poor': -3, 'fail': -3, 'failed': -3, 'failure': -3,
  'wrong': -3, 'negative': -3, 'loss': -3, 'losses': -3, 'lost': -3,
  'crash': -3, 'crashed': -3, 'crisis': -3, 'danger': -3, 'dangerous': -3,
  'fear': -3, 'fears': -3, 'worried': -3, 'worry': -3, 'alarming': -3,
  'angry': -2, 'anger': -2, 'blame': -2, 'blamed': -2, 'damage': -2,
  'damaged': -2, 'delay': -2, 'delayed': -2, 'disappointing': -2,
  'disappointed': -2, 'doubt': -2, 'doubts': -2, 'fall': -2, 'fallen': -2,
  'guilty': -2, 'harm': -2, 'harmful': -2, 'hurt': -2, 'mistake': -2,
  'mistakes': -2, 'painful': -2, 'reject': -2, 'rejected': -2,
  'struggle': -2, 'struggling': -2, 'threat': -2, 'threats': -2,
  'trouble': -2, 'troubled': -2, 'warning': -2, 'warnings': -2,

  // Strongly negative (-4 to -5)
  'terrible': -4, 'horrible': -4, 'awful': -4, 'worst': -4, 'disaster': -4,
  'catastrophe': -4, 'catastrophic': -4, 'devastating': -4, 'tragic': -4,
  'tragedy': -4, 'death': -4, 'dead': -4, 'kill': -4, 'killed': -4,
  'murder': -5, 'murdered': -5, 'attack': -4, 'attacked': -4, 'violent': -4,
  'violence': -4, 'war': -4, 'terror': -5, 'terrorist': -5, 'terrorism': -5,
  'fraud': -4, 'scam': -4, 'scandal': -4, 'corrupt': -4, 'corruption': -4,
  'bankrupt': -4, 'bankruptcy': -4, 'collapse': -4, 'collapsed': -4,
};

/**
 * Calculate sentiment score for a text string
 * @param {string} text - Text to analyze
 * @returns {number} Normalized score 0-100 (50 = neutral)
 */
function calculateSentiment(text) {
  if (!text || typeof text !== 'string') return 50;

  // Tokenize: lowercase, remove punctuation, split on whitespace
  const words = text.toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 0);

  if (words.length === 0) return 50;

  let totalScore = 0;
  let matchedWords = 0;

  for (const word of words) {
    if (AFINN_WORDS.hasOwnProperty(word)) {
      totalScore += AFINN_WORDS[word];
      matchedWords++;
    }
  }

  // No sentiment words found = neutral
  if (matchedWords === 0) return 50;

  // Normalize: score = 50 + (totalScore / words.length) * 10
  // This gives us a score where:
  // - 50 = neutral
  // - Higher = more positive
  // - Lower = more negative
  const normalizedScore = 50 + (totalScore / words.length) * 10;

  // Clamp to 0-100 range
  return Math.min(100, Math.max(0, Math.round(normalizedScore)));
}

/**
 * Calculate average sentiment across multiple articles
 * @param {Array} articles - Array of article objects with title property
 * @returns {Object} { score: number, classification: string, articlesAnalyzed: number }
 */
function calculateArticleSentiment(articles) {
  if (!articles || !Array.isArray(articles) || articles.length === 0) {
    return { score: 50, classification: 'Neutral', articlesAnalyzed: 0 };
  }

  let totalScore = 0;
  let analyzedCount = 0;

  for (const article of articles) {
    const title = article.title || article.name || '';
    if (title) {
      totalScore += calculateSentiment(title);
      analyzedCount++;
    }
  }

  if (analyzedCount === 0) {
    return { score: 50, classification: 'Neutral', articlesAnalyzed: 0 };
  }

  const averageScore = Math.round(totalScore / analyzedCount);

  // Classify sentiment
  let classification;
  if (averageScore <= 30) classification = 'Negative';
  else if (averageScore <= 45) classification = 'Somewhat Negative';
  else if (averageScore <= 55) classification = 'Neutral';
  else if (averageScore <= 70) classification = 'Somewhat Positive';
  else classification = 'Positive';

  return { score: averageScore, classification, articlesAnalyzed: analyzedCount };
}

module.exports = {
  AFINN_WORDS,
  calculateSentiment,
  calculateArticleSentiment,
};
