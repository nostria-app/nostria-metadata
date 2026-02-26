const { SimplePool } = require('nostr-tools/pool');
const WebSocket = require('ws');
const { useWebSocketImplementation } = require('nostr-tools/pool');

// Configure WebSocket for Node.js environment
useWebSocketImplementation(WebSocket);

class NostrService {
  constructor() {
    this.pool = null;

    this.defaultEventRelays = this.parseRelayList(
      process.env.DEFAULT_EVENT_RELAYS || process.env.DEFAULT_RELAYS,
      [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://premium.primal.net',
        'wss://relay.snort.social',
        'wss://nostr.wine',
        'wss://relay.nos.social',
        'wss://nostr.mom',
        'wss://relay.mostr.pub',
      ]
    );

    this.defaultProfileRelays = this.parseRelayList(
      process.env.DEFAULT_PROFILE_RELAYS || process.env.DEFAULT_RELAYS,
      [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nos.social',
        'wss://relay.snort.social',
        'wss://relay.primal.net',
        'wss://premium.primal.net',
        'wss://nostr.wine',
        'wss://nostr.mom',
        'wss://relay.mostr.pub',
      ]
    );

    this.timeout = Number.parseInt(process.env.RELAY_TIMEOUT || '3000', 10);
    this.profileTimeout = Number.parseInt(process.env.PROFILE_RELAY_TIMEOUT || String(this.timeout), 10);
    this.retryTimeout = Number.parseInt(process.env.RELAY_RETRY_TIMEOUT || '1800', 10);
    this.profileCacheTtlMs = Number.parseInt(process.env.PROFILE_CACHE_TTL_MS || '60000', 10);
    this.profileCache = new Map();
  }

  parseRelayList(relaysString, fallbackRelays) {
    const source = relaysString ? relaysString.split(',') : fallbackRelays;
    return [...new Set(source
      .map((relay) => relay.trim())
      .filter((relay) => relay.startsWith('wss://') || relay.startsWith('ws://')),
    )];
  }

  getAllKnownRelays() {
    return [...new Set([...this.defaultEventRelays, ...this.defaultProfileRelays])];
  }

  buildRelayList(relayHints = [], type = 'event') {
    const baseRelays = type === 'profile' ? this.defaultProfileRelays : this.defaultEventRelays;
    return [...new Set([...relayHints, ...baseRelays])];
  }

  getCachedProfile(pubkey) {
    const cached = this.profileCache.get(pubkey);
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.timestamp > this.profileCacheTtlMs) {
      this.profileCache.delete(pubkey);
      return null;
    }

    return cached.value;
  }

  setCachedProfile(pubkey, profile) {
    this.profileCache.set(pubkey, {
      value: profile,
      timestamp: Date.now(),
    });
  }

  async fetchFromRelays(relays, filter, timeoutMs) {
    return this.pool.get(
      relays,
      filter,
      {
        timeout: timeoutMs,
      }
    );
  }

  async fetchWithRetry(relays, filter, timeoutMs, contextLabel) {
    const firstTry = await this.fetchFromRelays(relays, filter, timeoutMs);
    if (firstTry) {
      return firstTry;
    }

    const allRelays = this.getAllKnownRelays();
    const retryRelays = [...new Set([...relays, ...allRelays])];

    if (retryRelays.length <= relays.length) {
      return null;
    }

    console.warn(`${contextLabel} not found on first relay set, retrying with expanded relay set (${retryRelays.length} relays)`);
    return this.fetchFromRelays(retryRelays, filter, this.retryTimeout);
  }

  initialize() {
    if (this.pool) {
      this.pool.close(this.getAllKnownRelays());
    }
    this.pool = new SimplePool();
    console.log(`Initialized Nostr pool with event relays: ${this.defaultEventRelays.join(', ')}`);
    console.log(`Initialized Nostr pool with profile relays: ${this.defaultProfileRelays.join(', ')}`);
  }

  /**
   * Fetch a Nostr event by its ID
   * @param {string} eventId - The event ID in hex format
   * @param {Array<string>} relayHints - Optional relay hints
   * @returns {Promise<Object>} The event object
   */
  async getEvent(eventId, relayHints = []) {
    if (!this.pool) {
      this.initialize();
    }

    if (!eventId) {
      throw new Error('eventId is required');
    }

    const relays = this.buildRelayList(relayHints, 'event');

    try {
      const event = await this.fetchWithRetry(
        relays,
        {
          ids: [eventId]
        },
        this.timeout,
        `Event ${eventId}`
      );

      if (!event) {
        console.log(`Event ${eventId} not found`);
        return null;
      }

      // If this is a note, also get the author's profile
      if (event.pubkey) {
        try {
          const authorProfile = await this.getProfile(event.pubkey, relayHints);
          if (authorProfile) {
            // Add author profile information to the event
            event.author = authorProfile;
          }
        } catch (error) {
          console.warn(`Could not fetch author profile for event ${eventId}:`, error.message);
        }
      }

      return event;
    } catch (error) {
      console.error(`Error fetching event ${eventId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch a Nostr profile by pubkey
   * @param {string} pubkey - The public key in hex format
   * @param {Array<string>} relayHints - Optional relay hints
   * @returns {Promise<Object>} The profile object
   */
  async getProfile(pubkey, relayHints = []) {
    if (!this.pool) {
      this.initialize();
    }

    if (!pubkey) {
      throw new Error('pubkey is required');
    }

    const cachedProfile = this.getCachedProfile(pubkey);
    if (cachedProfile) {
      return cachedProfile;
    }

    const relays = this.buildRelayList(relayHints, 'profile');

    try {
      // Get the most recent kind 0 event (metadata) for this pubkey
      const profileEvent = await this.fetchWithRetry(
        relays,
        {
          kinds: [0],
          authors: [pubkey]
        },
        this.profileTimeout,
        `Profile ${pubkey}`
      );

      if (!profileEvent) {
        return null;
      }

      let profileData;
      try {
        profileData = JSON.parse(profileEvent.content);
      } catch (e) {
        console.error(`Error parsing profile content for ${pubkey}:`, e);
        profileData = {}; // Default to empty object if parsing fails
      }

      const result = {
        ...profileEvent,
        profile: profileData
      };

      this.setCachedProfile(pubkey, result);

      // Return both the raw event and the parsed profile data
      return result;
    } catch (error) {
      console.error(`Error fetching profile ${pubkey}:`, error);
      throw error;
    }
  }

  /**
   * Clean up resources when shutting down
   */
  close() {
    if (this.pool) {
      this.pool.close(this.getAllKnownRelays());
      this.pool = null;
    }
    this.profileCache.clear();
  }

  /**
   * Fetch a Nostr article by it's author and identifier
   * @param {string} author - The author in hex format
   * @param {string} identifier - The article identifier
   * @param {number} kind - The event kind
   * @param {Array<string>} relayHints - Optional relay hints
   * @returns {Promise<Object>} The event object
   */
  async getArticle(author, identifier, kind, relayHints = []) {
    if (!this.pool) {
      this.initialize();
    }

    if (!author || !identifier || !kind) {
      throw new Error('author, identifier and kind are required');
    }

    const relays = this.buildRelayList(relayHints, 'event');

    try {
      const filter = {
        authors: [author],
        kinds: [kind],
        [`#d`]: [identifier]
      };

      const authorProfilePromise = this.getProfile(author, relayHints).catch((error) => {
        console.warn(`Could not fetch author profile for article ${author}:${identifier}:${kind}:`, error.message);
        return null;
      });

      const event = await this.fetchWithRetry(
        relays,
        filter,
        this.timeout,
        `Article ${author}:${identifier}:${kind}`
      );

      if (!event) {
        console.warn(`Article ${author}:${identifier}:${kind} not found`);
        return null;
      }

      const authorProfile = await authorProfilePromise;
      if (authorProfile) {
        event.author = authorProfile;
      }

      return event;
    } catch (error) {
      console.error(`Error fetching article ${author}:${identifier}:${kind}:`, error);
      throw error;
    }
  }
}

module.exports = new NostrService();