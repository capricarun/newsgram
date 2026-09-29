// Preset news sources. Each category lists candidate RSS URLs tried in order;
// the first one that returns items wins. Google News (site: search) is the
// last-resort fallback when a publisher blocks or moves its feed.

export const CATEGORIES = [
  { id: 'top', label: 'Top Stories', gnews: '' },
  { id: 'india', label: 'India', gnews: 'India' },
  { id: 'world', label: 'World', gnews: 'world' },
  { id: 'business', label: 'Business', gnews: 'business OR economy OR markets' },
  { id: 'sports', label: 'Sports', gnews: 'sports OR cricket' },
  { id: 'entertainment', label: 'Entertainment', gnews: 'entertainment OR bollywood' },
  { id: 'tech', label: 'Tech', gnews: 'technology OR gadgets' },
];

export const SOURCES = [
  {
    id: 'thehindu',
    name: 'The Hindu',
    domain: 'thehindu.com',
    color: '#1D6FE0',
    x: 'the_hindu',
    feeds: {
      top: ['https://www.thehindu.com/feeder/default.rss', 'https://www.thehindu.com/news/feeder/default.rss'],
      india: ['https://www.thehindu.com/news/national/feeder/default.rss'],
      world: ['https://www.thehindu.com/news/international/feeder/default.rss'],
      business: ['https://www.thehindu.com/business/feeder/default.rss'],
      sports: ['https://www.thehindu.com/sport/feeder/default.rss'],
      entertainment: ['https://www.thehindu.com/entertainment/feeder/default.rss'],
      tech: ['https://www.thehindu.com/sci-tech/technology/feeder/default.rss'],
    },
  },
  {
    id: 'indianexpress',
    name: 'Indian Express',
    domain: 'indianexpress.com',
    color: '#E0312F',
    x: 'IndianExpress',
    feeds: {
      top: ['https://indianexpress.com/feed/'],
      india: ['https://indianexpress.com/section/india/feed/'],
      world: ['https://indianexpress.com/section/world/feed/'],
      business: ['https://indianexpress.com/section/business/feed/'],
      sports: ['https://indianexpress.com/section/sports/feed/'],
      entertainment: ['https://indianexpress.com/section/entertainment/feed/'],
      tech: ['https://indianexpress.com/section/technology/feed/'],
    },
  },
  {
    id: 'toi',
    name: 'Times of India',
    domain: 'timesofindia.indiatimes.com',
    color: '#F2A93B',
    x: 'timesofindia',
    feeds: {
      top: ['https://timesofindia.indiatimes.com/rssfeedstopstories.cms'],
      india: ['https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms'],
      world: ['https://timesofindia.indiatimes.com/rssfeeds/296589292.cms'],
      business: ['https://timesofindia.indiatimes.com/rssfeeds/1898055.cms'],
      sports: ['https://timesofindia.indiatimes.com/rssfeeds/4719148.cms'],
      entertainment: ['https://timesofindia.indiatimes.com/rssfeeds/1081479906.cms'],
      tech: ['https://timesofindia.indiatimes.com/rssfeeds/66949542.cms'],
    },
  },
  {
    id: 'ht',
    name: 'Hindustan Times',
    domain: 'hindustantimes.com',
    color: '#00A3E0',
    x: 'htTweets',
    feeds: {
      top: ['https://www.hindustantimes.com/feeds/rss/latest/rssfeed.xml', 'https://www.hindustantimes.com/feeds/rss/topnews/rssfeed.xml'],
      india: ['https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml'],
      world: ['https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml'],
      business: ['https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml'],
      sports: ['https://www.hindustantimes.com/feeds/rss/sports/rssfeed.xml', 'https://www.hindustantimes.com/feeds/rss/cricket/rssfeed.xml'],
      entertainment: ['https://www.hindustantimes.com/feeds/rss/entertainment/rssfeed.xml'],
      tech: ['https://www.hindustantimes.com/feeds/rss/technology/rssfeed.xml', 'https://www.hindustantimes.com/feeds/rss/tech/rssfeed.xml'],
    },
  },
  {
    id: 'ndtv',
    name: 'NDTV',
    domain: 'ndtv.com',
    color: '#E4002B',
    x: 'ndtv',
    feeds: {
      top: ['https://feeds.feedburner.com/ndtvnews-top-stories'],
      india: ['https://feeds.feedburner.com/ndtvnews-india-news'],
      world: ['https://feeds.feedburner.com/ndtvnews-world-news'],
      business: ['https://feeds.feedburner.com/ndtvprofit-latest'],
      sports: ['https://feeds.feedburner.com/ndtvsports-latest'],
      entertainment: ['https://feeds.feedburner.com/ndtvmovies-latest'],
      tech: ['https://feeds.feedburner.com/gadgets360-latest'],
    },
  },
  {
    id: 'news18',
    name: 'CNN-News18',
    domain: 'news18.com',
    color: '#C8102E',
    x: 'CNNnews18',
    feeds: {
      top: ['https://www.news18.com/commonfeeds/v1/eng/rss/latest.xml', 'https://www.news18.com/rss/india.xml'],
      india: ['https://www.news18.com/commonfeeds/v1/eng/rss/india.xml', 'https://www.news18.com/rss/india.xml'],
      world: ['https://www.news18.com/commonfeeds/v1/eng/rss/world.xml', 'https://www.news18.com/rss/world.xml'],
      business: ['https://www.news18.com/commonfeeds/v1/eng/rss/business.xml', 'https://www.news18.com/rss/business.xml'],
      sports: ['https://www.news18.com/commonfeeds/v1/eng/rss/sports.xml', 'https://www.news18.com/rss/sports.xml'],
      entertainment: ['https://www.news18.com/commonfeeds/v1/eng/rss/entertainment.xml', 'https://www.news18.com/rss/entertainment.xml'],
      tech: ['https://www.news18.com/commonfeeds/v1/eng/rss/tech.xml', 'https://www.news18.com/rss/tech.xml'],
    },
  },
];

export function googleNewsUrl(source, category) {
  const cat = CATEGORIES.find((c) => c.id === category);
  const q = `site:${source.domain} ${cat?.gnews || ''} when:2d`.trim();
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
}
