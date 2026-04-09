require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { nip19 } = require('nostr-tools');
const { marked } = require('marked');
const nostrService = require('./services/nostrService');
const cheerio = require('cheerio');
const axios = require('axios');
const http = require('http');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;
const ogCacheTtlMs = Number.parseInt(process.env.OG_CACHE_TTL_MS || '3600000', 10);
const ogErrorCacheTtlMs = Number.parseInt(process.env.OG_ERROR_CACHE_TTL_MS || '300000', 10);
const ogRequestTimeoutMs = Number.parseInt(process.env.OG_REQUEST_TIMEOUT_MS || '4000', 10);
const ignoredOgDomainList = [
  'andrzej.btc',
  'core.excludesfile',
  'necessary.so',
];
const ignoredOgDomains = new Set([
  ...ignoredOgDomainList,
  ...(process.env.OG_IGNORED_DOMAINS || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean),
]);
const metadataBypassOgDomainList = [
  'reddit.com',
];
const metadataBypassOgDomains = new Set([
  ...metadataBypassOgDomainList,
  ...(process.env.OG_METADATA_BYPASS_DOMAINS || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean),
]);

const axiosClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// In-memory cache with TTL
class MemoryCache {
  constructor() {
    this.cache = new Map();
  }

  set(key, value, ttl = 3600000) { // Default TTL: 1 hour (3600000ms)
    const expiresAt = Date.now() + ttl;
    this.cache.set(key, { value, expiresAt });
  }

  get(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return cached.value;
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  // Clean up expired entries
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

// Create cache instance
const cache = new MemoryCache();
const inFlightRequests = new Map();

function normalizeTargetUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  const trimmedUrl = rawUrl.trim().replace(/[\s,]+$/g, '');
  if (!(trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://'))) {
    return null;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);
    parsedUrl.hash = '';
    return parsedUrl.toString();
  } catch (error) {
    return null;
  }
}

function parseBooleanQueryParam(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalizedValue = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(normalizedValue)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'off'].includes(normalizedValue)) {
    return false;
  }

  return defaultValue;
}

function isIgnoredOgDomain(targetUrl) {
  return matchesDomainList(targetUrl, ignoredOgDomains);
}

function shouldBypassOgMetadataFetch(targetUrl) {
  return matchesDomainList(targetUrl, metadataBypassOgDomains);
}

function matchesDomainList(targetUrl, domainList) {
  try {
    const hostname = new URL(targetUrl).hostname.toLowerCase().replace(/\.+$/, '');

    for (const domain of domainList) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return true;
      }
    }

    return false;
  } catch (error) {
    return false;
  }
}

function buildBasicOgResponse(targetUrl) {
  return {
    ok: true,
    status: 200,
    body: {
      url: targetUrl,
    },
    cacheAliases: [targetUrl],
  };
}

function sendOgResponse(res, response) {
  if (response.ok) {
    return res.json(response.body);
  }

  return res.status(response.status).json(response.body);
}

function sendMarkdownResponse(res, response) {
  if (response.ok) {
    return res.type('text/markdown; charset=utf-8').send(response.body);
  }

  return res.status(response.status).json(response.body);
}

function cacheOgResponse(cacheKey, response, ttl) {
  cache.set(cacheKey, response, ttl);

  const resolvedUrl = response.cacheAliases?.[0];
  if (!resolvedUrl) {
    return;
  }

  const normalizedResolvedUrl = normalizeTargetUrl(resolvedUrl);
  if (!normalizedResolvedUrl) {
    console.warn(`Could not normalize resolved URL for cache: ${resolvedUrl}`);
    return;
  }

  const cacheKeyPrefix = cacheKey.includes(':') ? cacheKey.slice(0, cacheKey.indexOf(':')) : cacheKey;
  const resolvedCacheKey = `${cacheKeyPrefix}:${normalizedResolvedUrl}`;
  if (resolvedCacheKey !== cacheKey) {
    cache.set(resolvedCacheKey, response, ttl);
  }
}

function buildUrlFetchErrorResponse(targetUrl, status, message, finalUrl = targetUrl, suggestion) {
  const body = {
    error: message,
    statusCode: status,
    url: targetUrl,
  };

  if (suggestion) {
    body.suggestion = suggestion;
  }

  return {
    ok: false,
    status,
    body,
    cacheAliases: [finalUrl],
  };
}

async function fetchUrlDocument(targetUrl) {
  console.log(`Fetching document for: ${targetUrl}`);

  let response;
  let finalUrl = targetUrl;

  try {
    response = await axiosClient.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      },
      maxRedirects: 20,
      timeout: ogRequestTimeoutMs,
      validateStatus: function (status) {
        return status >= 200 && status < 500;
      }
    });

    finalUrl = response.request.res?.responseUrl || targetUrl;

    console.log(`Successfully fetched ${targetUrl}, status: ${response.status}, final URL: ${finalUrl}`);

    if (response.status === 403) {
      console.error(`Got 403 from ${targetUrl}`);
      return buildUrlFetchErrorResponse(
        targetUrl,
        403,
        'The target server is blocking this request (Cloudflare protection detected)',
        finalUrl,
        'This URL is protected by Cloudflare. The content cannot be fetched server-side.'
      );
    }

    if (response.status >= 400) {
      return buildUrlFetchErrorResponse(
        targetUrl,
        response.status,
        `Failed to fetch URL: ${response.statusText}`,
        finalUrl
      );
    }

    return {
      ok: true,
      status: response.status,
      html: typeof response.data === 'string' ? response.data : String(response.data || ''),
      finalUrl,
      cacheAliases: [finalUrl],
    };
  } catch (error) {
    console.error(`Error fetching ${targetUrl}:`, error.message);

    if (error.code === 'ECONNABORTED') {
      return buildUrlFetchErrorResponse(
        targetUrl,
        504,
        `Timed out fetching URL after ${ogRequestTimeoutMs}ms`,
        finalUrl
      );
    }

    if (error.response) {
      return buildUrlFetchErrorResponse(
        targetUrl,
        error.response.status,
        `Failed to fetch URL: ${error.response.statusText || error.message}`,
        finalUrl
      );
    }

    throw error;
  }
}

function extractOpenGraphMetadataFromHtml(html, targetUrl, finalUrl) {
  const $ = cheerio.load(html);

  const metadata = {
    title: $('meta[property="og:title"]').attr('content'),
    description: $('meta[property="og:description"]').attr('content'),
    url: $('meta[property="og:url"]').attr('content') || finalUrl || targetUrl,
    image: $('meta[property="og:image"]').attr('content'),
    imageWidth: $('meta[property="og:image:width"]').attr('content'),
    imageHeight: $('meta[property="og:image:height"]').attr('content')
  };

  if (!metadata.title) metadata.title = $('title').text();
  if (!metadata.description) metadata.description = $('meta[name="description"]').attr('content');

  const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
  if (metaRefresh && !metadata.title && !metadata.description) {
    const refreshMatch = metaRefresh.match(/url=(.+)/i);
    if (refreshMatch) {
      const refreshUrl = refreshMatch[1].trim();
      console.log(`Meta refresh detected, following to: ${refreshUrl}`);
    }
  }

  return metadata;
}

function normalizeWhitespace(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function escapeMarkdownText(value) {
  return normalizeWhitespace(value).replace(/\\/g, '\\\\').replace(/([`*_\[\]<>])/g, '\\$1');
}

function absolutizeUrl(url, baseUrl) {
  if (!url) {
    return '';
  }

  try {
    return new URL(url, baseUrl).toString();
  } catch (error) {
    return url;
  }
}

function selectReadableContentRoot($) {
  const candidates = [
    'article',
    'main',
    '[role="main"]',
    '.article-content',
    '.article-body',
    '.entry-content',
    '.post-content',
    '.content',
    '#content',
    '.main-content',
    '.markdown-body',
    'body',
  ];

  let bestNode = $('body').first();
  let bestScore = 0;

  for (const selector of candidates) {
    $(selector).each((_, element) => {
      const textLength = normalizeWhitespace($(element).text()).length;
      if (textLength > bestScore) {
        bestScore = textLength;
        bestNode = $(element);
      }
    });
  }

  return bestNode;
}

function renderInlineMarkdown($, nodes, baseUrl) {
  const parts = [];

  for (const node of nodes) {
    if (!node) {
      continue;
    }

    if (node.type === 'text') {
      const text = node.data.replace(/\s+/g, ' ');
      if (text.trim()) {
        parts.push(escapeMarkdownText(text));
      }
      continue;
    }

    if (node.type !== 'tag') {
      continue;
    }

    const tagName = node.name.toLowerCase();

    if (tagName === 'br') {
      parts.push('  \n');
      continue;
    }

    if (tagName === 'code') {
      const codeText = normalizeWhitespace($(node).text());
      if (codeText) {
        parts.push(`\`${codeText.replace(/`/g, '\\`')}\``);
      }
      continue;
    }

    if (tagName === 'a') {
      const href = absolutizeUrl($(node).attr('href'), baseUrl);
      const label = renderInlineMarkdown($, $(node).contents().toArray(), baseUrl) || escapeMarkdownText($(node).text()) || href;
      parts.push(href ? `[${label}](${href})` : label);
      continue;
    }

    if (tagName === 'strong' || tagName === 'b') {
      const text = renderInlineMarkdown($, $(node).contents().toArray(), baseUrl);
      if (text) {
        parts.push(`**${text}**`);
      }
      continue;
    }

    if (tagName === 'em' || tagName === 'i') {
      const text = renderInlineMarkdown($, $(node).contents().toArray(), baseUrl);
      if (text) {
        parts.push(`*${text}*`);
      }
      continue;
    }

    if (tagName === 'img') {
      const src = absolutizeUrl($(node).attr('src'), baseUrl);
      const alt = escapeMarkdownText($(node).attr('alt') || 'Image');
      if (src) {
        parts.push(`![${alt}](${src})`);
      }
      continue;
    }

    const text = renderInlineMarkdown($, $(node).contents().toArray(), baseUrl);
    if (text) {
      parts.push(text);
    }
  }

  return parts.join('').replace(/[ \t]{2,}/g, ' ').trim();
}

function renderListMarkdown($, listNode, baseUrl, depth = 0) {
  const ordered = listNode.name.toLowerCase() === 'ol';
  const items = $(listNode).children('li').toArray();
  const lines = [];

  items.forEach((itemNode, index) => {
    const marker = ordered ? `${index + 1}. ` : '- ';
    const indent = '  '.repeat(depth);
    const itemClone = $(itemNode).clone();
    itemClone.children('ul, ol').remove();
    const itemText = renderInlineMarkdown($, itemClone.contents().toArray(), baseUrl);
    const nestedBlocks = $(itemNode)
      .children('ul, ol')
      .toArray()
      .map((nestedList) => renderListMarkdown($, nestedList, baseUrl, depth + 1))
      .filter(Boolean)
      .join('\n');

    if (itemText) {
      lines.push(`${indent}${marker}${itemText}`);
    }

    if (nestedBlocks) {
      lines.push(nestedBlocks);
    }
  });

  return lines.join('\n').trim();
}

function renderBlockMarkdown($, nodes, baseUrl, depth = 0) {
  const blocks = [];

  for (const node of nodes) {
    if (!node) {
      continue;
    }

    if (node.type === 'text') {
      const text = normalizeWhitespace(node.data);
      if (text) {
        blocks.push(escapeMarkdownText(text));
      }
      continue;
    }

    if (node.type !== 'tag') {
      continue;
    }

    const tagName = node.name.toLowerCase();

    if (['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'form'].includes(tagName)) {
      continue;
    }

    if (/^h[1-6]$/.test(tagName)) {
      const level = Number.parseInt(tagName[1], 10);
      const headingText = renderInlineMarkdown($, $(node).contents().toArray(), baseUrl);
      if (headingText) {
        blocks.push(`${'#'.repeat(level)} ${headingText}`);
      }
      continue;
    }

    if (tagName === 'p') {
      const paragraph = renderInlineMarkdown($, $(node).contents().toArray(), baseUrl);
      if (paragraph) {
        blocks.push(paragraph);
      }
      continue;
    }

    if (tagName === 'pre') {
      const code = $(node).text().replace(/\r/g, '').trim();
      if (code) {
        blocks.push(`\`\`\`\n${code}\n\`\`\``);
      }
      continue;
    }

    if (tagName === 'blockquote') {
      const quote = renderBlockMarkdown($, $(node).contents().toArray(), baseUrl, depth + 1)
        .split('\n')
        .map((line) => line ? `> ${line}` : '>')
        .join('\n')
        .trim();
      if (quote) {
        blocks.push(quote);
      }
      continue;
    }

    if (tagName === 'ul' || tagName === 'ol') {
      const listMarkdown = renderListMarkdown($, node, baseUrl, depth);
      if (listMarkdown) {
        blocks.push(listMarkdown);
      }
      continue;
    }

    if (tagName === 'img') {
      const imageMarkdown = renderInlineMarkdown($, [node], baseUrl);
      if (imageMarkdown) {
        blocks.push(imageMarkdown);
      }
      continue;
    }

    if (tagName === 'hr') {
      blocks.push('---');
      continue;
    }

    const childNodes = $(node).contents().toArray();
    const childBlocks = renderBlockMarkdown($, childNodes, baseUrl, depth);
    if (childBlocks) {
      blocks.push(childBlocks);
      continue;
    }

    const inline = renderInlineMarkdown($, childNodes, baseUrl);
    if (inline) {
      blocks.push(inline);
    }
  }

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractReadableMarkdown(html, baseUrl) {
  const $ = cheerio.load(html);
  const contentRoot = selectReadableContentRoot($);
  const contentHtml = contentRoot.html() || '';

  if (!contentHtml) {
    return '';
  }

  const $content = cheerio.load(`<div id="content-root">${contentHtml}</div>`);
  $content('script, style, noscript, iframe, svg, canvas, form, nav, footer, header, aside').remove();
  $content('[aria-hidden="true"], [hidden]').remove();

  const markdown = renderBlockMarkdown($content, $content('#content-root').contents().toArray(), baseUrl);
  return normalizeWhitespace(markdown);
}

function buildMarkdownDocument(metadata, contentMarkdown, targetUrl, finalUrl) {
  const title = escapeMarkdownText(metadata.title || 'Untitled Document');
  const description = normalizeWhitespace(metadata.description || '');
  const metadataLines = [
    `- Source URL: ${targetUrl}`,
  ];

  if (finalUrl && finalUrl !== targetUrl) {
    metadataLines.push(`- Final URL: ${finalUrl}`);
  }

  if (metadata.url && metadata.url !== finalUrl && metadata.url !== targetUrl) {
    metadataLines.push(`- OpenGraph URL: ${metadata.url}`);
  }

  if (metadata.image) {
    metadataLines.push(`- OpenGraph image: ${metadata.image}`);
  }

  if (metadata.imageWidth || metadata.imageHeight) {
    metadataLines.push(`- OpenGraph image size: ${metadata.imageWidth || '?'} x ${metadata.imageHeight || '?'}`);
  }

  const sections = [`# ${title}`];

  if (description) {
    sections.push(description);
  }

  sections.push(`## Metadata\n${metadataLines.join('\n')}`);

  if (contentMarkdown) {
    sections.push(`## Content\n${contentMarkdown}`);
  }

  const markdownDocument = `${sections.filter(Boolean).join('\n\n').trim()}\n`;
  marked.lexer(markdownDocument);
  return markdownDocument;
}

async function fetchMarkdownDocument(targetUrl, includeContent = true) {
  const documentResponse = await fetchUrlDocument(targetUrl);
  if (!documentResponse.ok) {
    return documentResponse;
  }

  const metadata = extractOpenGraphMetadataFromHtml(documentResponse.html, targetUrl, documentResponse.finalUrl);
  const contentMarkdown = includeContent
    ? extractReadableMarkdown(documentResponse.html, documentResponse.finalUrl)
    : '';
  const markdownDocument = buildMarkdownDocument(
    metadata,
    contentMarkdown,
    targetUrl,
    documentResponse.finalUrl,
  );

  return {
    ok: true,
    status: 200,
    body: markdownDocument,
    cacheAliases: [documentResponse.finalUrl, metadata.url],
  };
}

async function fetchOpenGraphMetadata(targetUrl) {
  const documentResponse = await fetchUrlDocument(targetUrl);
  if (!documentResponse.ok) {
    return documentResponse;
  }

  const metadata = extractOpenGraphMetadataFromHtml(documentResponse.html, targetUrl, documentResponse.finalUrl);

  return {
    ok: true,
    status: 200,
    body: {
      ...metadata,
    },
    cacheAliases: [documentResponse.finalUrl, metadata.url],
  };
}

// Clean up expired cache entries every 10 minutes
setInterval(() => {
  cache.cleanup();
}, 600000);

// Middleware
app.use(express.json());

// Add CORS middleware to allow requests from any origin
app.use(cors());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// OpenGraph metadata endpoint
app.get('/og', async (req, res) => {
  try {
    const targetUrl = normalizeTargetUrl(req.query.url);

    // Basic validation of the URL
    if (!targetUrl || !(targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      return res.status(400).json({
        error: 'Invalid URL. URL must be provided as a query parameter and start with http:// or https://',
        example: '/og?url=https://example.com'
      });
    }

    if (isIgnoredOgDomain(targetUrl)) {
      console.log(`Ignoring OpenGraph fetch for blocked domain: ${targetUrl}`);
      return res.status(204).end();
    }

    if (shouldBypassOgMetadataFetch(targetUrl)) {
      console.log(`Bypassing OpenGraph metadata fetch for domain: ${targetUrl}`);
      const cacheKey = `og:${targetUrl}`;
      const result = buildBasicOgResponse(targetUrl);
      cacheOgResponse(cacheKey, result, ogCacheTtlMs);
      return sendOgResponse(res, result);
    }

    // Check cache first
    const cacheKey = `og:${targetUrl}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return sendOgResponse(res, cachedResult);
    }

    let requestPromise = inFlightRequests.get(cacheKey);
    if (!requestPromise) {
      requestPromise = fetchOpenGraphMetadata(targetUrl)
        .then((result) => {
          const ttl = result.ok ? ogCacheTtlMs : ogErrorCacheTtlMs;
          cacheOgResponse(cacheKey, result, ttl);
          return result;
        })
        .finally(() => {
          inFlightRequests.delete(cacheKey);
        });

      inFlightRequests.set(cacheKey, requestPromise);
    }

    const result = await requestPromise;
    return sendOgResponse(res, result);
  } catch (error) {
    console.error('OpenGraph extraction error:', error);
    res.status(500).json({ error: 'Failed to extract OpenGraph metadata', details: error.message });
  }
});

// Markdown document endpoint for AI-friendly URL reading
app.get('/markdown', async (req, res) => {
  try {
    const targetUrl = normalizeTargetUrl(req.query.url);
    const includeContent = parseBooleanQueryParam(req.query.content, true);

    if (!targetUrl || !(targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      return res.status(400).json({
        error: 'Invalid URL. URL must be provided as a query parameter and start with http:// or https://',
        example: '/markdown?url=https://example.com&content=false'
      });
    }

    if (isIgnoredOgDomain(targetUrl)) {
      console.log(`Ignoring Markdown fetch for blocked domain: ${targetUrl}`);
      return res.status(204).end();
    }

    const cacheKey = `markdown:${includeContent ? 'full' : 'meta'}:${targetUrl}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return sendMarkdownResponse(res, cachedResult);
    }

    let requestPromise = inFlightRequests.get(cacheKey);
    if (!requestPromise) {
      requestPromise = fetchMarkdownDocument(targetUrl, includeContent)
        .then((result) => {
          const ttl = result.ok ? ogCacheTtlMs : ogErrorCacheTtlMs;
          cacheOgResponse(cacheKey, result, ttl);
          return result;
        })
        .finally(() => {
          inFlightRequests.delete(cacheKey);
        });

      inFlightRequests.set(cacheKey, requestPromise);
    }

    const result = await requestPromise;
    return sendMarkdownResponse(res, result);
  } catch (error) {
    console.error('Markdown extraction error:', error);
    res.status(500).json({ error: 'Failed to extract Markdown document', details: error.message });
  }
});

// Event endpoint - Handles both nevent1 and hex IDs
app.get('/e/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    let id;
    let relayHints = [];

    // Check cache first
    const cacheKey = `event:${eventId}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // Determine if the eventId is a nevent1 or hex
    if (eventId.startsWith('nevent1')) {
      try {
        const decoded = nip19.decode(eventId);
        if (decoded.type !== 'note' && decoded.type !== 'nevent') {
          return res.status(400).json({ error: 'Invalid nevent format' });
        }

        if (decoded.type === 'note') {
          id = decoded.data;
        } else {
          id = decoded.data.id;
          relayHints = decoded.data.relays || [];
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid nevent format', details: error.message });
      }
    } else {
      // Assume it's a hex id
      id = eventId;
    }

    // Fetch the event using our nostrService
    const event = await nostrService.getEvent(id, relayHints);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Cache the result for 1 hour
    cache.set(cacheKey, event);

    res.json(event);
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Failed to fetch event', details: error.message });
  }
});

// Profile endpoint - Handles both nprofile1 and hex pubkeys
app.get('/p/:profileId', async (req, res) => {
  try {
    const { profileId } = req.params;
    let pubkey;
    let relayHints = [];

    // Check cache first
    const cacheKey = `profile:${profileId}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // Determine if the profileId is a nprofile1 or hex
    if (profileId.startsWith('nprofile') || profileId.startsWith('npub')) {
      try {
        const decoded = nip19.decode(profileId);
        if (decoded.type !== 'nprofile' && decoded.type !== 'npub') {
          return res.status(400).json({ error: 'Invalid nprofile format' });
        }

        if (decoded.type === 'npub') {
          pubkey = decoded.data;
        } else {
          pubkey = decoded.data.pubkey;
          relayHints = decoded.data.relays || [];
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid nprofile format', details: error.message });
      }
    }
    else {
      // Assume it's a hex pubkey
      pubkey = profileId;
    }

    // Fetch the profile using our nostrService
    const author = await nostrService.getProfile(pubkey, relayHints);

    const profile = {
      content: author.profile.about || '',
      author: author,
    }

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Cache the result for 1 hour
    cache.set(cacheKey, profile);

    res.json(profile);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile', details: error.message });
  }
});

// Article endpoint
app.get('/a/:addr', async (req, res) => {
  try {
    const { addr } = req.params;
    let id;
    let relayHints = [];

    // Check cache first
    const cacheKey = `article:${addr}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    if (!addr.startsWith('naddr')) {
      return res.status(400).json({ error: 'Invalid address format. Must start with naddr.' });
    }

    const decoded = nip19.decode(addr);
    relayHints = decoded.data.relays || [];

    // Determine if the eventId is a nevent1 or hex
    // Fetch the event using our nostrService
    const event = await nostrService.getArticle(decoded.data.pubkey, decoded.data.identifier, decoded.data.kind, relayHints);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Cache the result for 1 hour
    cache.set(cacheKey, event);

    return res.json(event);
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Failed to fetch event', details: error.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Nostria Metadata API running on port ${port}`);
  nostrService.initialize();
});
